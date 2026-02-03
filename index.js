const { Telegraf, Markup, session } = require('telegraf');
const { chromium } = require('playwright');
const mongoose = require('mongoose');
const crypto = require('crypto');
const https = require('https');

// ============================================================
// 🔐 ЗАВАНТАЖЕННЯ СЕКРЕТІВ З .env ФАЙЛУ
// ============================================================
require('dotenv').config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL;
const MONGO_DB_URL = process.env.MONGO_DB_URL;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
// ============================================================

mongoose.connect(MONGO_DB_URL)
    .then(() => console.log('✅ MongoDB підключено!'))
    .catch(err => sendAdminError('Помилка підключення БД', err));

const UserSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true },
    firstName: String,
    searchesLeft: { type: Number, default: 100 },
    savedVacancies: [{
        title: String,
        url: String,
        summary: String,
        date: { type: Date, default: Date.now }
    }],
    registeredAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
bot.use(session());

// --- ФУНКЦІЯ: ПОВІДОМИТИ АДМІНА ---
async function sendAdminError(context, error) {
    console.error(`❌ ${context}:`, error);
    try {
        if (ADMIN_ID) {
            await bot.telegram.sendMessage(ADMIN_ID, `⚠️ <b>Помилка бота:</b>\n\nContext: ${context}\nError: ${error.message || error}`, { parse_mode: 'HTML' });
        }
    } catch (e) { console.error('Не зміг відправити лог адміну'); }
}

// --- ГОЛОВНЕ МЕНЮ ---
const mainMenu = Markup.keyboard([
    [Markup.button.webApp('🚀 ПОШУК', WEB_APP_URL)],
    [Markup.button.text('📂 Збережені вакансії')],
    [Markup.button.text('ℹ️ Допомога')] // Додали кнопку допомоги
]).resize();

// --- AI ANALYZER ---
async function analyzeWithGroq(text, filters) {
    if (!GROQ_API_KEY) return { valid: false, reason: "AI вимкнено" };

    if (text.length < 200 || text.includes("Cloudflare") || text.includes("Verify you are human")) {
        return { valid: false, reason: "⛔️ Сайт заблокував доступ (Captcha)" };
    }

    return new Promise((resolve) => {
        const data = JSON.stringify({
            model: "llama-3.3-70b-versatile",
            messages: [{
                role: "user",
                content: `Ти HR-асистент. Проаналізуй текст вакансії та перевір фільтри.

ТЕКСТ ВАКАНСІЇ:
"""${text.substring(0, 4000)}"""

ФІЛЬТРИ КОРИСТУВАЧА: ${JSON.stringify(filters)}

ПРАВИЛА ФІЛЬТРАЦІЇ (перевіряй СТРОГО!):

1. ФІЛЬТР "requireWebsite" (потрібен сайт компанії):
   - Якщо requireWebsite = true, шукай в тексті ПОСИЛАННЯ НА САЙТ КОМПАНІЇ
   - Сайт компанії це: example.com, company.ua, www.firma.com тощо
   - НЕ рахується сайтом: robota.ua, work.ua, linkedin.com, facebook.com, instagram.com, telegram
   - Якщо є тільки пошта (email) без сайту - це НЕ сайт компанії
   - Якщо сайту компанії НЕМАЄ -> valid: false, reason: "Немає сайту компанії"

2. ФІЛЬТР "skipFop" (пропускати ФОП):
   - Якщо skipFop = true, перевір чи це вакансія від ФОП
   - Ознаки ФОП: "ФОП", "фізична особа-підприємець", "оформлення на ФОП", "ФО-П"
   - Якщо це ФОП -> valid: false, reason: "Вакансія від ФОП"

3. ФІЛЬТР "allowRemote" (дозволити віддалену роботу):
   - Якщо allowRemote = false, вакансія НЕ повинна бути ТІЛЬКИ remote
   - Якщо робота ТІЛЬКИ віддалена без офісу -> valid: false, reason: "Тільки remote"
   - Якщо є офіс АБО гібрид -> valid: true

ВІДПОВІДАЙ СТРОГО JSON:
{ "valid": boolean, "reason": "причина якщо valid=false, інакше 'OK'", "summary": "Короткий опис вакансії українською (2-3 речення про компанію, позицію, умови)" }`
            }],
            response_format: { type: "json_object" }
        });

        const options = {
            hostname: 'api.groq.com',
            path: '/openai/v1/chat/completions',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` }
        };

        const req = https.request(options, (res) => {
            let chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const body = Buffer.concat(chunks).toString();
                    const response = JSON.parse(body);
                    if (response.choices && response.choices[0].message.content) {
                        resolve(JSON.parse(response.choices[0].message.content));
                    } else {
                        resolve({ valid: false, reason: "Пуста відповідь AI" });
                    }
                } catch (e) { resolve({ valid: false, reason: "JSON Error" }); }
            });
        });
        req.on('error', (e) => resolve({ valid: false, reason: "Network Error" }));
        req.write(data);
        req.end();
    });
}

function formatSummary(summaryData) {
    if (typeof summaryData === 'string') return summaryData;
    if (typeof summaryData === 'object' && summaryData !== null) {
        let parts = [];
        if (summaryData.position) parts.push(`🎯 ${summaryData.position}`);
        if (summaryData.company) parts.push(`🏢 ${summaryData.company}`);
        if (summaryData.location) parts.push(`📍 ${summaryData.location}`);
        if (summaryData.salary) parts.push(`💰 ${summaryData.salary}`);
        if (summaryData.description) return summaryData.description;
        return parts.length > 0 ? parts.join('\n') : JSON.stringify(summaryData);
    }
    return "Інформація відсутня";
}

// --- TINDER MODE ---
async function showCurrentVacancy(ctx) {
    const session = ctx.session;
    if (!session.candidates || session.currentIndex >= session.candidates.length) {
        try {
            await ctx.editMessageText(
                `🏁 <b>Перегляд завершено!</b>\nВсі лайкнуті вакансії збережено в меню "📂 Збережені".`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {
            // Ігноруємо помилку якщо повідомлення вже таке саме
            if (!e.message?.includes('message is not modified')) throw e;
        }
        return;
    }
    const vacancy = session.candidates[session.currentIndex];
    const cleanSummary = formatSummary(vacancy.summary);

    const progress = `[${session.currentIndex + 1}/${session.candidates.length}]`;
    const text = `${progress} <b>${vacancy.title}</b>\n\n🤖 ${cleanSummary}\n\n👉 <a href="${vacancy.url}">Детальніше на сайті</a>`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('👎 Пропустити', 'skip_next'), Markup.button.callback('❤️ Лайк', 'save_next')]
    ]);

    if (session.isFirstMessage) {
        await ctx.replyWithHTML(text, keyboard);
        session.isFirstMessage = false;
    } else {
        try { await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }); }
        catch (e) { await ctx.replyWithHTML(text, keyboard); }
    }
}

bot.action('save_next', async (ctx) => {
    try {
        const vacancy = ctx.session.candidates[ctx.session.currentIndex];
        const summaryToSave = formatSummary(vacancy.summary);

        // 👇 ЗАХИСТ ВІД ДУБЛІКАТІВ
        const user = await User.findOne({ telegramId: ctx.from.id });
        const alreadyExists = user.savedVacancies.some(v => v.url === vacancy.url);

        if (!alreadyExists) {
            await User.updateOne(
                { telegramId: ctx.from.id },
                { $push: { savedVacancies: { title: vacancy.title, url: vacancy.url, summary: summaryToSave } } }
            );
            await ctx.answerCbQuery('✅ Збережено!');
        } else {
            await ctx.answerCbQuery('⚠️ Вже є в списку!');
        }

        ctx.session.currentIndex++;
        await showCurrentVacancy(ctx);
    } catch (e) {
        sendAdminError('Save Error', e);
        ctx.answerCbQuery('❌ Помилка бази');
    }
});

bot.action('skip_next', async (ctx) => {
    await ctx.answerCbQuery('🗑 Пропущено');
    ctx.session.currentIndex++;
    await showCurrentVacancy(ctx);
});

// --- SCRAPING ENGINE ---
async function startBatchScraping(ctx, statusMsgId) {
    let browser = null;
    ctx.session.candidates = [];
    ctx.session.currentIndex = 0;
    ctx.session.isFirstMessage = true;

    try {
        browser = await chromium.launch({
            headless: true,
            executablePath: process.platform === 'linux' ? '/usr/bin/google-chrome' : undefined,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 }
        });
        const page = await context.newPage();

        await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, null, `🔎 Заходжу на сайт...`);

        try {
            await page.goto(ctx.session.searchUrl, { timeout: 45000, waitUntil: 'domcontentloaded' });
            await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, null, `⏳ Чекаю список вакансій...`);
            await new Promise(r => setTimeout(r, 5000));
        } catch (e) {
            await ctx.reply(`❌ Помилка доступу до сайту.`);
            await browser.close();
            return;
        }

        let links = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a'))
                .map(a => a.href)
                .filter(href => {
                    // Шукаємо посилання на вакансії
                    const hasVacancy = href.includes('vacancy') || href.includes('/jobs/') || href.includes('/job/');

                    // Виключаємо чисті профілі компаній (без вакансії в URL)
                    const isCompanyOnly = (href.includes('/company') || href.includes('/companies/')) && !href.includes('vacancy');

                    return hasVacancy && !isCompanyOnly;
                })
                .slice(0, 15); // Збільшив ліміт
        });

        if (links.length === 0) {
            const screenshotPath = 'debug_error.png';
            await page.screenshot({ path: screenshotPath });
            await ctx.replyWithPhoto({ source: screenshotPath }, { caption: '❌ Вакансій не знайдено (див. фото). Можливо капча.' });
            // Надсилаємо алерт адміну
            sendAdminError('Zero Vacancies Found', 'Bot got 0 links. Check screenshot.');
            await browser.close();
            return;
        }

        await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, null, `🔎 Знайдено ${links.length}. Аналізую...`);

        for (let i = 0; i < links.length; i++) {
            const link = links[i];
            if (i % 2 === 0) await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, null, `⚙️ Опрацьовано ${i} з ${links.length}...`);

            await new Promise(r => setTimeout(r, 2000));
            const tab = await context.newPage();
            try {
                await tab.goto(link, { waitUntil: 'domcontentloaded', timeout: 20000 });
                await new Promise(r => setTimeout(r, 1500)); // Трохи більше часу для SPA

                // 👇 ВИПРАВЛЕННЯ ЗАГОЛОВКІВ
                const title = await tab.evaluate(() => {
                    const h1 = document.querySelector('h1');
                    return h1 ? h1.innerText.trim() : document.title;
                });

                // Отримуємо весь текст сторінки
                const text = await tab.evaluate(() => document.body.innerText);

                // 👇 ПЕРЕВІРКА САЙТУ КОМПАНІЇ (НАДІЙНА - через текст сторінки)
                // На robota.ua якщо є сайт компанії, на сторінці буде текст "Сайт компанії"
                if (ctx.session.filters.requireWebsite) {
                    const hasWebsiteText = text.includes('Сайт компанії') ||
                        text.includes('сайт компанії') ||
                        text.includes('Веб-сайт:') ||
                        text.includes('Website:');

                    if (!hasWebsiteText) {
                        console.log(`⛔ ${title}: НЕМАЄ САЙТУ (пропущено)`);
                        await tab.close();
                        continue;
                    }
                }

                // 👇 AI АНАЛІЗУЄ: ФОП, remote (БЕЗ перевірки сайту - вже перевірили вище)
                // Видаляємо requireWebsite з фільтрів для AI, бо вже перевірили
                const filtersForAi = { ...ctx.session.filters, requireWebsite: false };
                const analysis = await analyzeWithGroq(text, filtersForAi);

                console.log(`📊 ${title}: ${analysis.valid ? '✅' : '❌'} ${analysis.reason || ''}`);

                if (analysis.valid) {
                    ctx.session.candidates.push({ title, url: link, summary: analysis.summary });
                }
            } catch (err) { console.log(`Link Error: ${err.message}`); }
            await tab.close();
        }

        await browser.close();
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsgId).catch(() => { });

        if (ctx.session.candidates.length > 0) {
            await ctx.reply(`🎉 Знайдено ${ctx.session.candidates.length} релевантних вакансій!`);
            await showCurrentVacancy(ctx);
        } else {
            await ctx.reply('😔 Жодна вакансія не пройшла фільтри ШІ.');
        }

    } catch (e) {
        sendAdminError('Critical Browser Error', e);
        ctx.reply('❌ Сталася критична помилка. Адміністратор повідомлений.');
        if (browser) await browser.close();
    }
}

// --- COMMANDS ---

bot.start(async (ctx) => {
    try {
        let user = await User.findOne({ telegramId: ctx.from.id });
        if (!user) {
            user = new User({ telegramId: ctx.from.id, firstName: ctx.from.first_name });
            await user.save();
        }
        ctx.reply(`Привіт! Обирай дію в меню 👇`, mainMenu);
    } catch (e) { sendAdminError('Start Error', e); }
});

bot.hears('ℹ️ Допомога', (ctx) => {
    ctx.replyWithHTML(
        `<b>🤖 Як користуватися ботом:</b>\n\n` +
        `1. Натисни <b>🚀 ПОШУК</b>.\n` +
        `2. Встав посилання з Work.ua або Robota.ua.\n` +
        `3. Бот проаналізує вакансії та покаже найкращі.\n` +
        `4. Тисни ❤️, щоб зберегти у <b>📂 Папку</b>.\n` +
        `5. Тисни 👎, щоб пропустити.\n\n` +
        `<i>Є питання? Пиши розробнику(@Andrey_Gordienkos).</i>`
    );
});

bot.hears('📂 Збережені вакансії', async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user || !user.savedVacancies || user.savedVacancies.length === 0) {
        return ctx.reply('📂 Твій список поки що порожній.');
    }
    let msg = '<b>📂 Твої збережені вакансії:</b>\n\n';
    user.savedVacancies.forEach((v, i) => {
        msg += `${i + 1}. <a href="${v.url}">${v.title}</a>\n`;
    });
    msg += '\n<i>Щоб очистити список, натисни /clear</i>';
    ctx.replyWithHTML(msg, { disable_web_page_preview: true });
});

bot.command('clear', async (ctx) => {
    await User.updateOne({ telegramId: ctx.from.id }, { savedVacancies: [] });
    ctx.reply('🗑 Список очищено!');
});

bot.on('web_app_data', async (ctx) => {
    try {
        const data = JSON.parse(ctx.message.web_app_data.data);

        // 👇 НОВА ПЕРЕВІРКА: ЧИ ЦЕ ВЗАГАЛІ САЙТ РОБОТИ?
        if (!data.url.includes('work.ua') && !data.url.includes('robota.ua')) {
            return ctx.reply('⛔️ Я вмію працювати тільки з Work.ua та Robota.ua. Будь ласка, встав правильне посилання.');
        }

        ctx.session = { filters: data, searchUrl: data.url };

        // Показуємо що шукаємо
        let searchMsg = '⚙️ Починаю пошук...';
        if (data.isSearch && data.originalQuery) {
            searchMsg = `🔍 Шукаю: "${data.originalQuery.replace('@', '')}"...`;
        }
        const msg = await ctx.reply(searchMsg);
        startBatchScraping(ctx, msg.message_id);
    } catch (e) { ctx.reply('Помилка даних WebApp'); }
});

bot.launch().then(() => {
    console.log('🚀 БОТ ЗАПУЩЕНО (MVP VERSION)');
    // Можна відправити собі тест, що бот встав
    // bot.telegram.sendMessage(ADMIN_ID, '🚀 Бот успішно перезапущено!');
});

// Обробка зупинки (Ctrl+C)
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));