'use strict';
const axios = require('axios');

/* ============================================================
 *  الإعدادات (Config)
 * ============================================================ */
const G2G_COOKIES = process.env.G2G_COOKIES;
const FUNPAY_COOKIES = process.env.FUNPAY_COOKIES;

const FUNPAY_BASE = (process.env.FUNPAY_BASE || 'https://funpay.com').replace(/\/$/, '');
const FUNPAY_USERNAME = process.env.FUNPAY_USERNAME || 'QuickSellProo';
const FUNPAY_USER_ID = process.env.FUNPAY_USER_ID || '20896682';
const FUNPAY_PROFILE_PATH = `/en/users/${FUNPAY_USER_ID}/`;

// الأقسام الافتراضية (كاحتياطي) + يكتشف البوت تلقائياً كل الأقسام من صفحة البروفايل
const INITIAL_NODES = (process.env.FUNPAY_RAISE_NODES || '47,3050,139')
    .split(',').map(s => s.trim()).filter(Boolean);
const activeRaiseNodes = new Set(INITIAL_NODES);
const nodeNames = new Map(); // nodeId -> اسم القسم (مثل Albion Online Accounts)

// اختياري: لو السكربت ماعرفش يلاقي game_id تلقائياً. الصيغة: "47:41,3050:12"
const GAME_ID_OVERRIDES = Object.fromEntries(
    (process.env.FUNPAY_GAME_IDS || '').split(',').map(s => s.trim().split(':')).filter(p => p.length === 2)
);

// الفاصل بين كل Boost والتاني (بالدقائق) - عشوائي حوالي 3 ساعات
const RAISE_INTERVAL_MIN = [165, 205];
// كل قد إيه نسأل FunPay عن المبيعات/الرسائل (وده كمان اللي بيخلي الحساب "Online")
const RUNNER_INTERVAL_MS = [35000, 65000];
// كل قد إيه نفحص صفحتك الشخصية لاكتشاف أي عروض جديدة أضفتها (كل ساعة)
const DISCOVER_INTERVAL_MS = 60 * 60 * 1000;

const TEST_MODE = process.env.TEST_MODE === 'true';
const TIME_SCALE = Number(process.env.TIME_SCALE || 1);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_API = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');

if (!G2G_COOKIES && !FUNPAY_COOKIES) {
    console.error('Error: No cookies found for any store in Secrets!');
    process.exit(1);
}

/* ============================================================
 *  أدوات مساعدة
 * ============================================================ */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms / TIME_SCALE));
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const minutes = (n) => n * 60 * 1000;
const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[${ts()}]`, ...a);
const shuffle = (arr) => arr.map(v => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
const randomTag = () => Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[randomInt(0, 35)]).join('');

const decodeEntities = (s) => String(s)
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const escapeHtml = (s) => String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const asJson = (d) => {
    if (d && typeof d === 'object') return d;
    try { return JSON.parse(d); } catch { return null; }
};

/* ============================================================
 *  الترجمة الفورية (Google Translate API مجاني)
 * ============================================================ */
async function translateText(text, targetLang = 'ar') {
    if (!text) return null;
    try {
        const res = await axios.get('https://translate.googleapis.com/translate_a/single', {
            params: {
                client: 'gtx',
                sl: 'auto',
                tl: targetLang,
                dt: 't',
                q: text
            },
            timeout: 10000
        });
        if (Array.isArray(res.data) && Array.isArray(res.data[0])) {
            const translated = res.data[0].map(part => part[0]).join('');
            const detectedLang = res.data[2] || 'auto';
            return { translated, detectedLang };
        }
    } catch (e) {
        log('Translation error:', e.message);
    }
    return null;
}

/* ============================================================
 *  Telegram (إرسال + أزرار + ترجمة + الرد على العملاء)
 * ============================================================ */
const tgMessageCache = new Map();
let awaitingReplyFor = null;
let tgUpdateOffset = 0;

async function sendTelegram(text, options = {}) {
    const firstLine = stripTags(text).split('\n')[0];
    log(`📨 ${firstLine}`);
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return null;
    try {
        const payload = {
            chat_id: TELEGRAM_CHAT_ID,
            text,
            parse_mode: options.parse_mode || 'HTML',
            disable_web_page_preview: true,
            ...(options.reply_markup ? { reply_markup: options.reply_markup } : {}),
            ...(options.reply_to_message_id ? { reply_to_message_id: options.reply_to_message_id } : {})
        };
        const res = await axios.post(`${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, payload, { timeout: 15000 });
        return res.data && res.data.result ? res.data.result : null;
    } catch (e) {
        log('Telegram send failed:', e.response ? JSON.stringify(e.response.data) : e.message);
        return null;
    }
}

async function editTelegramMessage(messageId, text, replyMarkup) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
    try {
        await axios.post(`${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
            chat_id: TELEGRAM_CHAT_ID,
            message_id: messageId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {})
        }, { timeout: 15000 });
        return true;
    } catch (e) {
        log('Telegram edit failed:', e.response ? JSON.stringify(e.response.data) : e.message);
        return false;
    }
}

async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
    try {
        await axios.post(`${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: callbackQueryId,
            text,
            show_alert: showAlert
        }, { timeout: 10000 });
    } catch { /* ignore */ }
}

const activeAlerts = new Set();
async function alertOnce(key, text) {
    if (activeAlerts.has(key)) return;
    activeAlerts.add(key);
    await sendTelegram(text);
}
const clearAlert = (key) => activeAlerts.delete(key);

async function telegramDiscoverChatId() {
    try {
        const r = await axios.get(`${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/getUpdates`, { timeout: 15000 });
        const chats = new Map();
        for (const u of (r.data.result || [])) {
            const c = (u.message || u.edited_message || u.channel_post || {}).chat;
            if (c) chats.set(c.id, c.username || c.first_name || c.title || '');
        }
        if (!chats.size) {
            log('⚠️ مفيش رسائل للبوت لسه. افتح البوت في تيليجرام واكتب /start وبعدين شغّل test_mode تاني.');
        }
        for (const [id, name] of chats) log(`👉 TELEGRAM_CHAT_ID = ${id}   (${name})`);
    } catch (e) {
        log('getUpdates failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    }
}

function buildFunPayChatKeyboard(chatId, translated = false) {
    return {
        inline_keyboard: [
            [
                { text: translated ? '🔄 إخفاء الترجمة' : '🌐 ترجمة للعربية', callback_data: `tr:${chatId}` },
                { text: '✍️ رد من تيليجرام', callback_data: `rep:${chatId}` }
            ],
            [
                { text: '🔗 فتح الشات في FunPay', url: `${FUNPAY_BASE}/en/chat/?node=${chatId}` }
            ]
        ]
    };
}

function formatFunPayChatAlert({ chatId, name, text, translatedText, lang }) {
    let msg =
        `💬 <b>رسالة جديدة على FunPay</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>المرسل:</b> <code>${escapeHtml(name || 'مستخدم')}</code>\n` +
        `🆔 <b>رقم الشات:</b> <code>#chat_${escapeHtml(chatId)}</code>\n\n` +
        `📝 <b>النص الأصلي:</b>\n` +
        `<blockquote>${escapeHtml(text || '(بدون نص)')}</blockquote>`;

    if (translatedText) {
        msg += `\n\n🌐 <b>الترجمة للعربية${lang ? ` (من ${lang.toUpperCase()})` : ''}:</b>\n` +
               `<blockquote>${escapeHtml(translatedText)}</blockquote>`;
    }

    msg += `\n\n💡 <i>للرد السريع: اسحب هذه الرسالة لليمين (Reply) واكتب ردك مباشرة.</i>`;
    return msg;
}

/* ============================================================
 *  إعدادات المتصفح والـ Cookies
 * ============================================================ */
const BROWSER_BASE = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
};

const XHR_BASE = {
    'User-Agent': BROWSER_BASE['User-Agent'],
    'Accept': '*/*',
    'Sec-Ch-Ua': BROWSER_BASE['Sec-Ch-Ua'],
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest'
};

/* ============================================================
 *  G2G
 * ============================================================ */
const g2gHeaders = {
    ...BROWSER_BASE,
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    'Cookie': G2G_COOKIES,
    'Referer': 'https://www.g2g.com/'
};

const pingG2G = async () => {
    if (!G2G_COOKIES) {
        log('G2G skipped: G2G_COOKIES missing');
        return;
    }
    try {
        const response = await axios.get('https://www.g2g.com/QuickSellPro', { headers: g2gHeaders });
        if (response.status === 200) {
            log('G2G Status: Online 🟢');
        } else {
            log(`G2G Response Code: ${response.status}`);
        }
    } catch (error) {
        console.error(`[${ts()}] Error pinging G2G:`, error.response ? error.response.status : error.message);
    }
};

/* ============================================================
 *  FunPay: الجلسة + الاكتشاف التلقائي من /en/users/20896682/
 * ============================================================ */
class CookieJar {
    constructor(str) {
        this.map = new Map();
        (str || '').split(';').forEach(p => {
            const i = p.indexOf('=');
            if (i > 0) this.map.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
        });
    }
    update(setCookie) {
        for (const c of [].concat(setCookie || [])) {
            const pair = c.split(';')[0];
            const i = pair.indexOf('=');
            if (i <= 0) continue;
            const k = pair.slice(0, i).trim();
            const v = pair.slice(i + 1).trim();
            if (v && v !== 'deleted') this.map.set(k, v);
        }
    }
    header() {
        return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
    }
}
const jar = new CookieJar(FUNPAY_COOKIES);

async function fp(method, path, { data, headers, xhr } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await axios({
                method,
                url: FUNPAY_BASE + path,
                data,
                headers: {
                    ...(xhr ? XHR_BASE : BROWSER_BASE),
                    'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8,ar;q=0.7',
                    'Referer': FUNPAY_BASE + '/',
                    ...headers,
                    'Cookie': jar.header()
                },
                timeout: 30000,
                maxRedirects: 5,
                validateStatus: () => true
            });
            jar.update(res.headers['set-cookie']);
            return res;
        } catch (e) {
            lastErr = e;
            if (attempt < 3) await sleep(randomInt(3000, 8000) * attempt);
        }
    }
    throw lastErr;
}

function parseAppData(html) {
    const m = html.match(/data-app-data="([^"]+)"/) || html.match(/data-app-data='([^']+)'/);
    if (!m) return null;
    try { return JSON.parse(decodeEntities(m[1])); } catch { return null; }
}

function isLoggedIn(html, app) {
    if (app && Number(app.userId) > 0) return true;
    return html.includes(FUNPAY_USERNAME);
}

const ctx = { userId: FUNPAY_USER_ID, csrf: null };

async function loadFunPaySession() {
    // ندخل مباشرة على صفحة البروفايل لتحديث الجلسة + الـ CSRF في خطوة واحدة
    const res = await fp('get', FUNPAY_PROFILE_PATH);
    const html = String(res.data);
    if (res.status !== 200) return { ok: false, status: res.status };
    const app = parseAppData(html);
    if (!isLoggedIn(html, app)) return { ok: false, status: 200, loggedOut: true };
    if (app) {
        if (Number(app.userId) > 0) ctx.userId = String(app.userId);
        if (app['csrf-token']) ctx.csrf = app['csrf-token'];
    }
    return { ok: true, html };
}

const nextRaiseAt = new Map();

/**
 * يفحص صفحة https://funpay.com/en/users/20896682/
 * ويستخرج كل الأقسام المعروضة حالياً (مثل Albion Online Accounts, Marvel Rivals Accounts, Overwatch 2 Accounts, إلخ)
 */
async function discoverFunPayLots(silent = false,prefetchedHtml = null) {
    if (!FUNPAY_COOKIES) return;
    try {
        let html = prefetchedHtml;
        if (!html) {
            const res = await fp('get', FUNPAY_PROFILE_PATH);
            if (res.status !== 200) {
                log(`Discover lots (${FUNPAY_PROFILE_PATH}): HTTP ${res.status}`);
                return;
            }
            html = String(res.data);
            const app = parseAppData(html);
            if (app && app['csrf-token']) ctx.csrf = app['csrf-token'];
        }

        const discoveredNow = new Map(); // nodeId -> title

        // 1) التقاط عنوان كل قسم (مثل Albion Online Accounts) ورابطه /lots/<id>/
        for (const m of html.matchAll(/class="offer-list-title"[\s\S]{0,600}?href="[^"]*\/lots\/(\d+)\/?"[^>]*>([\s\S]*?)<\/a>/gi)) {
            const nodeId = m[1];
            const title = stripTags(m[2]);
            if (nodeId) discoveredNow.set(nodeId, title || `Node ${nodeId}`);
        }

        // 2) التقاط أيقونة القلم (/lots/<id>/trade) الخاصة برفع وتعديل العروض
        for (const m of html.matchAll(/\/lots\/(\d+)\/trade/gi)) {
            const nodeId = m[1];
            if (nodeId && !discoveredNow.has(nodeId)) {
                discoveredNow.set(nodeId, nodeNames.get(nodeId) || `Node ${nodeId}`);
            }
        }

        if (!discoveredNow.size) {
            log(`⚠️ لم يتم العثور على أقسام في ${FUNPAY_PROFILE_PATH}، سيتم استخدام القائمة الحالية: ${[...activeRaiseNodes].join(', ')}`);
            return;
        }

        const newlyAdded = [];
        for (const [nodeId, title] of discoveredNow) {
            if (title && !title.startsWith('Node ')) nodeNames.set(nodeId, title);
            if (!activeRaiseNodes.has(nodeId)) {
                activeRaiseNodes.add(nodeId);
                nextRaiseAt.set(nodeId, Date.now() + minutes(randomInt(1, 4)));
                newlyAdded.push(nodeNames.get(nodeId) ? `${nodeNames.get(nodeId)} (${nodeId})` : nodeId);
            }
        }

        // إذا تم حذف قسم بالكامل من حسابك على FunPay، نزيله من الـ Boost حتى لا يفشل
        for (const oldNode of [...activeRaiseNodes]) {
            if (!discoveredNow.has(oldNode)) {
                activeRaiseNodes.delete(oldNode);
                nextRaiseAt.delete(oldNode);
                log(`🗑️ تم إزالة القسم [${oldNode}] لأنه لم يعد معروضاً في صفحتك.`);
            }
        }

        const summary = [...activeRaiseNodes].map(id => nodeNames.get(id) ? `${nodeNames.get(id)} [${id}]` : id);
        log(`🔍 FunPay Discovered Offers (${activeRaiseNodes.size}): ${summary.join(' | ')}`);

        if (newlyAdded.length && !silent) {
            await sendTelegram(
                `🆕 <b>FunPay: تم اكتشاف عروض جديدة في حسابك!</b>\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `تمت إضافتها تلقائياً إلى جدول الـ Boost:\n` +
                newlyAdded.map(x => `• <b>${escapeHtml(x)}</b>`).join('\n')
            );
        }
    } catch (e) {
        log('discoverFunPayLots error:', e.message);
    }
}

/**
 * إرسال رسالة مباشرة إلى مشتري على FunPay عبر الـ runner
 */
async function sendFunPayMessage(chatId, messageText) {
    if (!FUNPAY_COOKIES) throw new Error('FUNPAY_COOKIES غير موجودة');
    if (!ctx.userId || !ctx.csrf) {
        const s = await loadFunPaySession();
        if (!s.ok || !ctx.csrf) throw new Error('فشل تحميل جلسة FunPay');
    }

    const objects = [
        {
            type: 'chat_node',
            id: String(chatId),
            tag: '00000000',
            data: { node: String(chatId), last_message: -1, content: '' }
        }
    ];
    const requestPayload = {
        action: 'chat_message',
        data: {
            node: String(chatId),
            last_message: -1,
            content: messageText
        }
    };

    const body = new URLSearchParams({
        objects: JSON.stringify(objects),
        request: JSON.stringify(requestPayload),
        csrf_token: ctx.csrf
    });

    const res = await fp('post', '/runner/', {
        xhr: true,
        data: body.toString(),
        headers: {
            'Origin': FUNPAY_BASE,
            'Referer': `${FUNPAY_BASE}/en/chat/?node=${chatId}`
        }
    });

    const json = asJson(res.data);
    if (res.status !== 200 || !json) {
        ctx.csrf = null;
        throw new Error(`HTTP ${res.status}`);
    }
    if (json.response && json.response.error) {
        throw new Error(stripTags(json.response.error));
    }
    return true;
}

const pingFunPay = async () => {
    if (!FUNPAY_COOKIES) {
        log('FunPay skipped: FUNPAY_COOKIES missing');
        return false;
    }
    try {
        const r = await loadFunPaySession();
        if (r.ok) {
            log('FunPay Status: Online 🟢');
            clearAlert('funpay-logout');
            return r.html;
        } else if (r.loggedOut) {
            log('FunPay Error: Cookies Expired / Logged Out 🔴');
            await alertOnce('funpay-logout', '🔴 <b>FunPay:</b> الكوكيز انتهت أو الحساب خرج.\nيرجى تحديث <code>FUNPAY_COOKIES</code> في GitHub Secrets.');
        } else {
            log(`FunPay Response Code: ${r.status}`);
        }
    } catch (error) {
        console.error(`[${ts()}] Error pinging FunPay:`, error.response ? error.response.status : error.message);
    }
    return false;
};

/* ---------- Runner: المبيعات + الرسائل + البقاء Online ---------- */
const rs = {
    ordersTag: randomTag(), chatTag: randomTag(),
    sellers: null,
    chat: null, chatMsg: null,
    bookTag: randomTag(),
    bookmarksOk: false,
    fails: 0
};
const chatSeen = new Map();
let bookBaseline = false;
const seenOrders = new Set();

function parseSales(html) {
    const out = [];
    for (const b of html.split(/<a[^>]+class="tc-item/).slice(1)) {
        const id = (b.match(/class="tc-order"[^>]*>\s*#?([A-Za-z0-9]+)/) || [])[1];
        if (!id) continue;
        const desc = stripTags((b.match(/class="order-desc"[^>]*>\s*<div>([\s\S]*?)<\/div>/) || [])[1]);
        const buyer = stripTags((b.match(/class="media-user-name"[^>]*>([\s\S]*?)<\/div>/) || [])[1]);
        const status = stripTags((b.match(/class="tc-status[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1]);
        const price = stripTags((b.match(/class="tc-price"[^>]*>([\s\S]*?)<\/div>/) || [])[1]);
        out.push({ id, desc, buyer, status, price, paid: /paid|оплачен/i.test(status) });
    }
    return out;
}

async function checkNewSales({ silent, prev, now }) {
    let sales = [];
    try {
        const res = await fp('get', '/en/orders/trade');
        if (res.status === 200) sales = parseSales(String(res.data));
    } catch (e) {
        log('orders/trade fetch failed:', e.message);
    }
    const fresh = sales.filter(s => s.paid && !seenOrders.has(s.id));
    fresh.forEach(s => seenOrders.add(s.id));
    if (silent) return;
    if (fresh.length) {
        for (const s of fresh.reverse()) {
            const orderUrl = `${FUNPAY_BASE}/en/orders/${s.id}/`;
            await sendTelegram(
                `💰 <b>FunPay: عملية بيع جديدة!</b>\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `🧾 <b>رقم الطلب:</b> <code>#${escapeHtml(s.id)}</code>\n` +
                (s.price ? `💵 <b>السعر:</b> <b>${escapeHtml(s.price)}</b>\n` : '') +
                (s.buyer ? `👤 <b>المشتري:</b> <code>${escapeHtml(s.buyer)}</code>\n` : '') +
                (s.desc ? `\n📦 <b>العرض:</b>\n<blockquote>${escapeHtml(s.desc)}</blockquote>\n` : ''),
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📦 فتح صفحة الطلب في FunPay', url: orderUrl }]
                        ]
                    }
                }
            );
        }
    } else if (now > prev) {
        await sendTelegram(
            `💰 <b>FunPay: عملية بيع جديدة!</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `📊 عدد المبيعات النشطة الآن: <b>${now}</b>`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📦 عرض المبيعات', url: `${FUNPAY_BASE}/en/orders/trade` }]
                    ]
                }
            }
        );
    }
}

async function onOrdersCounters(d) {
    const seller = Number(d.seller) || 0;
    const prev = rs.sellers;
    rs.sellers = seller;
    if (prev === null) {
        log(`FunPay sales counter: ${seller}`);
        if (seller > 0) await checkNewSales({ silent: true });
        return;
    }
    if (seller !== prev) await checkNewSales({ silent: false, prev, now: seller });
}

function parseContacts(html) {
    const out = [];
    for (const m of String(html || '').matchAll(/<a\b[^>]*class="[^"]*contact-item[^"]*"[^>]*>[\s\S]*?<\/a>/g)) {
        const block = m[0];
        const open = block.match(/^<a\b[^>]*>/)[0];
        const id = (open.match(/data-id="(\d+)"/) || [])[1];
        if (!id) continue;
        out.push({
            id,
            nodeMsg: (open.match(/data-node-msg="(\d+)"/) || [])[1] || '',
            unread: /class="[^"]*\bunread\b/.test(open),
            name: stripTags((block.match(/class="media-user-name"[^>]*>([\s\S]*?)<\/div>/) || [])[1]),
            text: stripTags((block.match(/class="contact-item-message"[^>]*>([\s\S]*?)<\/div>/) || [])[1])
        });
    }
    return out;
}

async function onChatBookmarks(d) {
    const contacts = parseContacts(d.html);
    if (!contacts.length) return;
    rs.bookmarksOk = true;
    if (!bookBaseline) {
        bookBaseline = true;
        contacts.forEach(c => chatSeen.set(c.id, c.nodeMsg));
        return;
    }
    for (const c of contacts) {
        const seen = chatSeen.get(c.id);
        chatSeen.set(c.id, c.nodeMsg);
        if (c.unread && c.nodeMsg && c.nodeMsg !== seen) {
            const text = c.text.length > 800 ? c.text.slice(0, 800) + '…' : c.text;
            const formatted = formatFunPayChatAlert({
                chatId: c.id,
                name: c.name,
                text
            });
            const sent = await sendTelegram(formatted, {
                reply_markup: buildFunPayChatKeyboard(c.id, false)
            });
            if (sent && sent.message_id) {
                tgMessageCache.set(sent.message_id, {
                    chatId: c.id,
                    senderName: c.name || 'مستخدم',
                    originalText: text,
                    translatedText: null,
                    lang: null,
                    showingTranslation: false
                });
                if (tgMessageCache.size > 200) {
                    const oldestKey = tgMessageCache.keys().next().value;
                    tgMessageCache.delete(oldestKey);
                }
            }
        }
    }
}

async function onChatCounter(d) {
    const counter = Number(d.counter) || 0;
    const msgId = d.message === undefined ? null : String(d.message);
    const prev = rs.chat;
    const prevMsg = rs.chatMsg;
    rs.chat = counter;
    rs.chatMsg = msgId;
    if (prev === null) {
        log(`FunPay unread chats: ${counter}`);
        return;
    }
    if (!rs.bookmarksOk && counter > 0 && (counter > prev || msgId !== prevMsg)) {
        await sendTelegram(
            `💬 <b>FunPay: لديك رسائل غير مقروءة (${counter})</b>`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💬 فتح الشات في FunPay', url: `${FUNPAY_BASE}/en/chat/` }]
                    ]
                }
            }
        );
    }
}

async function pollRunner() {
    if (!FUNPAY_COOKIES) return;
    try {
        if (!ctx.userId || !ctx.csrf) {
            const r = await loadFunPaySession();
            if (!r.ok || !ctx.csrf) throw new Error(r.loggedOut ? 'logged out' : 'no session data');
        }
        const objects = [
            { type: 'orders_counters', id: ctx.userId, tag: rs.ordersTag, data: false },
            { type: 'chat_counter', id: ctx.userId, tag: rs.chatTag, data: false },
            { type: 'chat_bookmarks', id: ctx.userId, tag: rs.bookTag, data: false }
        ];
        const body = new URLSearchParams({ objects: JSON.stringify(objects), request: 'false', csrf_token: ctx.csrf });
        const res = await fp('post', '/runner/', {
            xhr: true,
            data: body.toString(),
            headers: { 'Origin': FUNPAY_BASE, 'Referer': FUNPAY_BASE + '/en/' }
        });
        const json = asJson(res.data);
        if (TEST_MODE) log(`runner raw (HTTP ${res.status}): ${JSON.stringify(json || String(res.data).slice(0, 200)).slice(0, 400)}`);
        if (res.status !== 200 || !json || !Array.isArray(json.objects)) {
            ctx.csrf = null;
            throw new Error(`bad runner response (HTTP ${res.status})`);
        }
        const book = json.objects.find(o => o.type === 'chat_bookmarks');
        if (book) { if (book.tag) rs.bookTag = book.tag; await onChatBookmarks(book.data || {}); }
        for (const o of json.objects) {
            if (o.type === 'orders_counters') { if (o.tag) rs.ordersTag = o.tag; await onOrdersCounters(o.data || {}); }
            else if (o.type === 'chat_counter') { if (o.tag) rs.chatTag = o.tag; await onChatCounter(o.data || {}); }
        }
        if (rs.fails >= 5) await sendTelegram('🟢 <b>FunPay:</b> الاتصال عاد للعمل بشكل طبيعي.');
        rs.fails = 0;
        clearAlert('runner-fail');
    } catch (e) {
        rs.fails++;
        log(`runner error (${rs.fails}): ${e.message}`);
        if (rs.fails >= 5) {
            await alertOnce('runner-fail', `⚠️ <b>FunPay:</b> فشل الاتصال ${rs.fails} مرات متتالية (${escapeHtml(e.message)}).\nراجع صلاحية الكوكيز.`);
        }
    }
}

/* ============================================================
 *  استقبال أوامر تيليجرام (زر الترجمة + الرد على العملاء)
 * ============================================================ */
async function pollTelegramUpdates() {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const res = await axios.get(`${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/getUpdates`, {
            params: {
                offset: tgUpdateOffset,
                timeout: 0,
                allowed_updates: JSON.stringify(['message', 'callback_query'])
            },
            timeout: 12000
        });
        const updates = (res.data && res.data.result) || [];
        for (const u of updates) {
            tgUpdateOffset = u.update_id + 1;

            // 1) التعامل مع الأزرار (ترجمة / طلب رد)
            if (u.callback_query) {
                const cb = u.callback_query;
                const fromChatId = String(cb.message && cb.message.chat && cb.message.chat.id);
                if (fromChatId !== String(TELEGRAM_CHAT_ID)) continue;

                const data = String(cb.data || '');
                const msgId = cb.message.message_id;

                if (data.startsWith('tr:')) {
                    const fpChatId = data.slice(3);
                    let cached = tgMessageCache.get(msgId);

                    if (!cached) {
                        const rawText = cb.message.text || '';
                        const mName = rawText.match(/المرسل:\s*(.+)/);
                        const mOrig = rawText.match(/النص الأصلي:\n([\s\S]*?)(?:\n\n🌐|\n\n💡|$)/);
                        cached = {
                            chatId: fpChatId,
                            senderName: mName ? mName[1].trim() : 'مستخدم',
                            originalText: mOrig ? mOrig[1].trim() : rawText,
                            translatedText: null,
                            lang: null,
                            showingTranslation: false
                        };
                        tgMessageCache.set(msgId, cached);
                    }

                    if (cached.showingTranslation) {
                        cached.showingTranslation = false;
                        await editTelegramMessage(
                            msgId,
                            formatFunPayChatAlert({
                                chatId: cached.chatId,
                                name: cached.senderName,
                                text: cached.originalText
                            }),
                            buildFunPayChatKeyboard(cached.chatId, false)
                        );
                        await answerCallbackQuery(cb.id, 'تم إخفاء الترجمة');
                    } else {
                        await answerCallbackQuery(cb.id, '⏳ جاري الترجمة إلى العربية...');
                        if (!cached.translatedText) {
                            const tr = await translateText(cached.originalText, 'ar');
                            if (tr && tr.translated) {
                                cached.translatedText = tr.translated;
                                cached.lang = tr.detectedLang;
                            } else {
                                await answerCallbackQuery(cb.id, '❌ تعذرت الترجمة حالياً', true);
                                continue;
                            }
                        }
                        cached.showingTranslation = true;
                        await editTelegramMessage(
                            msgId,
                            formatFunPayChatAlert({
                                chatId: cached.chatId,
                                name: cached.senderName,
                                text: cached.originalText,
                                translatedText: cached.translatedText,
                                lang: cached.lang
                            }),
                            buildFunPayChatKeyboard(cached.chatId, true)
                        );
                    }
                } else if (data.startsWith('rep:')) {
                    const fpChatId = data.slice(4);
                    const cached = tgMessageCache.get(msgId);
                    const senderName = cached ? cached.senderName : `شات #${fpChatId}`;
                    awaitingReplyFor = { chatId: fpChatId, senderName };
                    await answerCallbackQuery(cb.id, `✍️ اكتب ردك الآن لإرساله إلى ${senderName}`);
                    await sendTelegram(
                        `✍️ <b>وضع الرد المباشر مفعّل</b>\n` +
                        `أرسل رسالتك الآن ليتم إرسالها فوراً إلى <b>${escapeHtml(senderName)}</b> (شات <code>#${escapeHtml(fpChatId)}</code>).\n` +
                        `<i>لإلغاء الرد أرسل /cancel</i>`,
                        {
                            reply_to_message_id: msgId,
                            reply_markup: { force_reply: true, selective: true }
                        }
                    );
                }
            }

            // 2) التعامل مع الرسائل النصية (الرد على العملاء أو الأوامر)
            if (u.message && u.message.text) {
                const msg = u.message;
                if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) continue;
                const text = msg.text.trim();

                if (text === '/cancel') {
                    awaitingReplyFor = null;
                    await sendTelegram('✅ تم إلغاء وضع الرد.', { reply_to_message_id: msg.message_id });
                    continue;
                }

                if (text === '/discover' || text === '/lots') {
                    await sendTelegram(`🔍 جاري فحص صفحتك (<code>${FUNPAY_PROFILE_PATH}</code>)...`, { reply_to_message_id: msg.message_id });
                    await discoverFunPayLots(false);
                    const allList = [...activeRaiseNodes].map(id => `• <b>${escapeHtml(nodeNames.get(id) || 'قسم')}</b> (<code>${id}</code>)`);
                    await sendTelegram(
                        `📋 <b>أقسام الـ Boost النشطة حالياً (${activeRaiseNodes.size}):</b>\n` +
                        allList.join('\n'),
                        { reply_to_message_id: msg.message_id }
                    );
                    continue;
                }

                let targetChatId = null;
                let targetName = 'المشتري';

                if (msg.reply_to_message) {
                    const repliedId = msg.reply_to_message.message_id;
                    const cached = tgMessageCache.get(repliedId);
                    if (cached) {
                        targetChatId = cached.chatId;
                        targetName = cached.senderName;
                    } else {
                        const repText = msg.reply_to_message.text || '';
                        const matchId = repText.match(/#chat_(\d+)/) || repText.match(/#(\d+)/);
                        const matchName = repText.match(/المرسل:\s*(.+)/);
                        if (matchId) targetChatId = matchId[1];
                        if (matchName) targetName = matchName[1].trim();
                    }
                }

                if (!targetChatId && awaitingReplyFor) {
                    targetChatId = awaitingReplyFor.chatId;
                    targetName = awaitingReplyFor.senderName;
                }

                if (targetChatId && !text.startsWith('/')) {
                    try {
                        await sendFunPayMessage(targetChatId, text);
                        awaitingReplyFor = null;
                        await sendTelegram(
                            `✅ <b>تم إرسال ردك بنجاح إلى ${escapeHtml(targetName)}!</b>\n` +
                            `<blockquote>${escapeHtml(text)}</blockquote>`,
                            { reply_to_message_id: msg.message_id }
                        );
                    } catch (e) {
                        await sendTelegram(
                            `❌ <b>فشل إرسال الرد إلى FunPay:</b>\n<code>${escapeHtml(e.message)}</code>`,
                            { reply_to_message_id: msg.message_id }
                        );
                    }
                }
            }
        }
    } catch (e) {
        log('pollTelegramUpdates error:', e.message);
    }
}

/* ---------- Boost offers ---------- */
function findGameId(html) {
    const patterns = [
        /js-lot-raise[^>]*data-game="(\d+)"/,
        /data-game="(\d+)"[^>]*js-lot-raise/,
        /lots\/raise[\s\S]{0,300}?game_id["'\s:=]+(\d+)/,
        /data-game="(\d+)"/
    ];
    for (const p of patterns) {
        const m = html.match(p);
        if (m) return m[1];
    }
    return null;
}

function parseWaitMs(msg) {
    const t = String(msg || '').toLowerCase();
    const part = (numRe, articleRe, unitMs) => {
        const n = t.match(numRe);
        if (n) return Number(n[1]) * unitMs;
        if (articleRe.test(t)) return unitMs;
        return 0;
    };
    const ms =
        part(/(\d+)\s*(?:hours?|hrs?|h\b|час)/, /\ban?\s+hour|(?:^|[^а-яё])час(?![а-яё])/, 3600000) +
        part(/(\d+)\s*(?:minutes?|mins?|мин)/, /\ban?\s+minute|минуту/, 60000) +
        part(/(\d+)\s*(?:seconds?|secs?|сек)/, /\ban?\s+second|секунду/, 1000);
    return ms > 0 ? ms : null;
}

async function raiseNode(nodeId) {
    const tradePath = `/en/lots/${nodeId}/trade`;
    const page = await fp('get', tradePath);
    const label = nodeNames.get(nodeId) ? `${nodeId} (${nodeNames.get(nodeId)})` : nodeId;

    if (page.status !== 200) {
        log(`Raise[${label}] ✗ trade page HTTP ${page.status}`);
        return { ok: false, nextInMs: minutes(randomInt(15, 30)) };
    }
    const html = String(page.data);
    const app = parseAppData(html);
    if (!isLoggedIn(html, app)) {
        log(`Raise[${label}] ✗ logged out 🔴`);
        return { ok: false, fatal: true, nextInMs: minutes(60) };
    }

    const gameId = GAME_ID_OVERRIDES[nodeId] || findGameId(html);
    if (!gameId) {
        log(`Raise[${label}] ✗ game_id not found in page.`);
        return { ok: false, nextInMs: minutes(randomInt(60, 90)) };
    }

    await sleep(randomInt(2000, 7000));

    const postRaise = async (extra) => {
        const body = new URLSearchParams({ game_id: gameId, node_id: nodeId });
        if (app && app['csrf-token']) body.append('csrf_token', app['csrf-token']);
        (extra || []).forEach(([k, v]) => body.append(k, v));
        return fp('post', '/lots/raise', {
            xhr: true,
            data: body.toString(),
            headers: { 'Origin': FUNPAY_BASE, 'Referer': FUNPAY_BASE + tradePath }
        });
    };

    let res = await postRaise();
    let json = asJson(res.data);

    if (json && json.modal) {
        const ids = [...String(json.modal).matchAll(/<input[^>]*name="node_ids\[\]"[^>]*>/g)]
            .map(m => (m[0].match(/value="(\d+)"/) || [])[1]).filter(Boolean);
        const toSend = ids.length ? ids.map(id => ['node_ids[]', String(id)]) : [['node_ids[]', String(nodeId)]];
        await sleep(randomInt(1500, 4000));
        res = await postRaise(toSend);
        json = asJson(res.data);
    }

    if (!json) {
        log(`Raise[${label}] ✗ unexpected response (HTTP ${res.status}): ${stripTags(res.data).slice(0, 200)}`);
        return { ok: false, nextInMs: minutes(randomInt(30, 60)) };
    }

    const msg = stripTags(json.msg || '');
    if (json.error || json.url) {
        const waitMs = parseWaitMs(msg);
        if (waitMs) {
            log(`Raise[${label}] ⏳ cooldown (game_id=${gameId}): "${msg}"`);
            return { ok: false, nextInMs: waitMs + minutes(randomInt(1, 6)) };
        }
        log(`Raise[${label}] ✗ FunPay said: "${msg}"`);
        return { ok: false, nextInMs: minutes(randomInt(30, 50)) };
    }

    log(`Raise[${label}] ✅ boosted (game_id=${gameId})${msg ? ` — "${msg}"` : ''}`);
    return { ok: true, nextInMs: minutes(randomInt(...RAISE_INTERVAL_MIN)) };
}

async function runDueRaises() {
    if (!FUNPAY_COOKIES) return;
    const allNodes = [...activeRaiseNodes];
    const due = shuffle(allNodes.filter(n => (nextRaiseAt.get(n) || 0) <= Date.now()));
    for (let i = 0; i < due.length; i++) {
        const node = due[i];
        try {
            const r = await raiseNode(node);
            nextRaiseAt.set(node, Date.now() + r.nextInMs);
            if (r.fatal) {
                await alertOnce('funpay-logout', '🔴 <b>FunPay:</b> الكوكيز انتهت، توقف الـ Boost التلقائي. حدّث <code>FUNPAY_COOKIES</code>.');
                allNodes.forEach(n => nextRaiseAt.set(n, Date.now() + r.nextInMs));
                return;
            }
            log(`Raise[${node}] next attempt in ~${(r.nextInMs / 3600000).toFixed(2)}h`);
        } catch (e) {
            log(`Raise[${node}] ✗ error: ${e.message}`);
            nextRaiseAt.set(node, Date.now() + minutes(randomInt(15, 30)));
        }
        if (i < due.length - 1) await sleep(randomInt(25000, 90000));
    }
}

/* ============================================================
 *  G2G: تنبيهات المبيعات وتجديد التوكن
 * ============================================================ */
const G2G_USER_ID = process.env.G2G_USER_ID || '1002988142';
const G2G_API = (process.env.G2G_API || 'https://sls.g2g.com').replace(/\/$/, '');
const G2G_LIST_ORDER_URL = process.env.G2G_LIST_ORDER_URL;
const G2G_POLL_MS = [90000, 150000];
const G2G_AUTO_REFRESH = process.env.G2G_AUTO_REFRESH === 'true';

const g2gJar = new CookieJar(G2G_COOKIES);
const g2g = { token: null, exp: 0, retryAt: 0, fails: 0, baseline: false, cancel: 0 };
const g2gSeen = new Set();
const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}/g;

function jwtInfo(t) {
    try {
        const pl = JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        return { exp: Number(pl.exp) * 1000 };
    } catch { return null; }
}

function pickJwt(text, source) {
    for (const m of String(text || '').matchAll(JWT_RE)) {
        const info = jwtInfo(m[0]);
        if (info && info.exp > Date.now() + 60000) return { token: m[0], exp: info.exp, source };
    }
    return null;
}

function keyNames(o, prefix = '') {
    if (o === null || typeof o !== 'object') return [];
    return Object.entries(o).flatMap(([k, v]) =>
        v && typeof v === 'object' ? keyNames(v, `${prefix}${k}.`) : [`${prefix}${k}`]);
}
function collectStrings(o, out = {}) {
    if (o && typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) {
            if (typeof v === 'string') out[k] = v; else collectStrings(v, out);
        }
    }
    return out;
}

function toMs(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
    const d = Date.parse(String(v));
    return Number.isFinite(d) ? d : null;
}

async function checkKeyExpiry(strsOrObj) {
    const flat = collectAny(strsOrObj);
    const items = ['refresh_token_exp', 'long_lived_token_exp', 'active_device_token_exp']
        .map(k => [k.replace('_exp', ''), toMs(flat[k])]).filter(([, ms]) => ms);
    if (!items.length) return;
    const days = items.map(([k, ms]) => [k, (ms - Date.now()) / 86400000]);
    log(`G2G keys expire in: ${days.map(([k, d]) => `${k} ${d.toFixed(1)}d`).join(' | ')}`);
    const soon = days.filter(([, d]) => d < 3);
    if (soon.length) {
        await alertOnce('g2g-keys-expiry',
            `⏰ <b>G2G:</b> مفاتيح التجديد قاربت على الانتهاء (${soon.map(([k, d]) => `${k}: ${d.toFixed(1)} يوم`).join('، ')}).\nسجّل دخول G2G من المتصفح وحدّث <code>G2G_COOKIES</code>.`);
    }
}
function collectAny(o, out = {}) {
    if (o && typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) {
            if (v && typeof v === 'object') collectAny(v, out); else out[k] = v;
        }
    }
    return out;
}

async function refreshG2gAccess() {
    const val = (n) => g2gJar.map.get(n);
    if (!val('refresh_token')) {
        log('G2G refresh ✗ كوكي refresh_token مش موجود في G2G_COOKIES');
        return null;
    }
    const body = {
        user_id: G2G_USER_ID,
        refresh_token: val('refresh_token'),
        long_lived_token: val('long_lived_token'),
        active_device_token: val('active_device_token')
    };
    const stale = g2g.token || process.env.G2G_ACCESS_TOKEN;
    const res = await axios.post(`${G2G_API}/user/refresh_access`, body, {
        headers: {
            'User-Agent': BROWSER_BASE['User-Agent'],
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.5',
            'Content-Type': 'application/json',
            ...(stale ? { 'Authorization': stale } : {}),
            'Origin': 'https://www.g2g.com',
            'Referer': 'https://www.g2g.com/',
            'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-site'
        },
        timeout: 20000, validateStatus: () => true
    });
    const names = keyNames(res.data).join(', ');
    log(`G2G refresh → HTTP ${res.status}${names ? ` | fields: ${names}` : ''}`);
    if (res.status !== 200) return null;

    const strs = collectStrings(res.data);
    for (const k of ['refresh_token', 'long_lived_token', 'active_device_token']) {
        if (strs[k] && strs[k] !== val(k)) {
            g2gJar.map.set(k, strs[k]);
            await alertOnce(`g2g-rotated-${k}`,
                `⚠️ <b>G2G:</b> السيرفر قام بتغيير <code>${k}</code> أثناء التجديد.`);
        }
    }
    await checkKeyExpiry(res.data);
    return pickJwt(typeof res.data === 'string' ? res.data : JSON.stringify(res.data), 'refresh_access');
}

async function discoverG2gToken() {
    if (Date.now() < g2g.retryAt) return false;
    let f = pickJwt(process.env.G2G_ACCESS_TOKEN, 'secret G2G_ACCESS_TOKEN');
    if (!f) {
        for (const [k, v] of g2gJar.map) {
            let val = v;
            try { val = decodeURIComponent(v); } catch { /* ignore */ }
            f = pickJwt(val, `cookie ${k}`);
            if (f) break;
        }
    }
    if (!f && G2G_AUTO_REFRESH) {
        try { f = await refreshG2gAccess(); } catch (e) { log(`G2G refresh failed: ${e.message}`); }
    }
    if (f) {
        g2g.token = f.token; g2g.exp = f.exp;
        log(`G2G token ✅ source: ${f.source} | valid for ${((f.exp - Date.now()) / 60000).toFixed(1)} min`);
    } else {
        g2g.token = null;
        g2g.retryAt = Date.now() + minutes(5);
        log(`G2G token ✗ not found${G2G_AUTO_REFRESH ? '' : ' (G2G_AUTO_REFRESH مش مفعّل)'}.`);
    }
    return !!f;
}

async function g2gGet(url) {
    if (!g2g.token || g2g.exp - Date.now() < 60000) {
        if (!(await discoverG2gToken())) return null;
    }
    const res = await axios.get(url, {
        headers: {
            'User-Agent': BROWSER_BASE['User-Agent'],
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.5',
            'Authorization': g2g.token,
            'Origin': 'https://www.g2g.com',
            'Referer': 'https://www.g2g.com/',
            'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-site'
        },
        timeout: 20000, validateStatus: () => true
    });
    if (res.status === 401 || res.status === 403) g2g.token = null;
    return res;
}

async function g2gOrderDetails() {
    if (!G2G_LIST_ORDER_URL) return {};
    try {
        const res = await g2gGet(G2G_LIST_ORDER_URL);
        const results = res && res.data && res.data.payload && res.data.payload.results;
        if (!Array.isArray(results)) return {};
        return Object.fromEntries(results.map(r => [r.order_item_id, r]));
    } catch { return {}; }
}

function g2gDetailLine(r) {
    if (!r) return '';
    let line = `📦 <b>الكمية:</b> ${escapeHtml(r.purchased_qty)} | 💵 <b>السعر:</b> <b>${escapeHtml(r.offer_amount)} ${escapeHtml(r.offer_currency)}</b>`;
    if (r.checkout_currency && r.checkout_currency !== r.offer_currency) {
        line += ` <i>(دفع المشتري: ${escapeHtml(r.amount)} ${escapeHtml(r.checkout_currency)})</i>`;
    }
    return line + '\n';
}

async function pollG2G() {
    if (!G2G_COOKIES && !process.env.G2G_ACCESS_TOKEN) return;
    try {
        const res = await g2gGet(`${G2G_API}/user/${G2G_USER_ID}/notification`);
        if (!res) throw new Error('no valid token');
        if (res.status !== 200 || !res.data || res.data.code !== 2000) {
            throw new Error(`HTTP ${res.status}${res.data && res.data.code ? ' code ' + res.data.code : ''}`);
        }
        const p = res.data.payload || {};
        const orders = p.orders || {};
        const sold = Array.isArray(orders.BO) ? orders.BO : [];
        const bought = Array.isArray(orders.CO) ? orders.CO : [];
        const cancel = Number(p.cancellation && p.cancellation.total) || 0;

        const fresh = [...sold.map(o => ({ ...o, kind: 'sold' })), ...bought.map(o => ({ ...o, kind: 'bought' }))]
            .filter(o => o.id && !g2gSeen.has(o.id));
        fresh.forEach(o => g2gSeen.add(o.id));

        if (!g2g.baseline) {
            g2g.baseline = true;
            g2g.cancel = cancel;
            log(`G2G notifications: sold=${sold.length} purchases=${bought.length} cancellations=${cancel}`);
        } else {
            if (fresh.length) {
                const details = await g2gOrderDetails();
                for (const o of fresh) {
                    const head = o.kind === 'sold' ? '💰 <b>G2G: عملية بيع جديدة!</b>' : '🧾 <b>G2G: تحديث على طلب شراء</b>';
                    const orderUrl = o.url || 'https://www.g2g.com/g2g-user/sale';
                    await sendTelegram(
                        `${head}\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `🆔 <b>رقم الطلب:</b> <code>#${escapeHtml(o.id)}</code>\n` +
                        g2gDetailLine(details[o.id]) +
                        (o.title ? `\n📝 <b>التفاصيل:</b>\n<blockquote>${escapeHtml(o.title)}</blockquote>` : ''),
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🔗 فتح الطلب في G2G', url: orderUrl }]
                                ]
                            }
                        }
                    );
                }
            }
            if (cancel > g2g.cancel) {
                await sendTelegram(
                    `⚠️ <b>G2G: طلب إلغاء جديد!</b>\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `العدد الحالي: <b>${cancel}</b>`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔗 مراجعة الطلبات في G2G', url: 'https://www.g2g.com/g2g-user/sale' }]
                            ]
                        }
                    }
                );
            }
            g2g.cancel = cancel;
        }
        if (g2g.fails >= 5) await sendTelegram('🟢 <b>G2G:</b> الاتصال عاد للعمل بشكل طبيعي.');
        g2g.fails = 0;
        clearAlert('g2g-fail');
    } catch (e) {
        g2g.fails++;
        log(`G2G poll error (${g2g.fails}): ${e.message}`);
        if (g2g.fails >= 5) {
            await alertOnce('g2g-fail', `⚠️ <b>G2G:</b> تعذرت قراءة الإشعارات (${escapeHtml(e.message)}).\nتأكد من صلاحية التوكن أو الكوكيز.`);
        }
    }
}

/* ============================================================
 *  تسليم التشغيل للنسخة اللي بعدها (بدون فجوات Offline)
 * ============================================================ */
async function relaunchSelf() {
    const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_REF_NAME } = process.env;
    if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_REF_NAME) {
        log('Handoff skipped (not running inside GitHub Actions).');
        return;
    }
    const wf = process.env.WORKFLOW_FILE || 'bot.yml';
    try {
        await axios.post(
            `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/${wf}/dispatches`,
            { ref: GITHUB_REF_NAME },
            {
                headers: {
                    Authorization: `Bearer ${GITHUB_TOKEN}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28'
                },
                timeout: 20000
            });
        log('🔁 Handoff: queued the next run (it starts as soon as this one ends).');
    } catch (e) {
        log('Handoff failed (cron will still cover it):', e.response ? JSON.stringify(e.response.data) : e.message);
        await alertOnce('handoff', '⚠️ فشل تشغيل النسخة القادمة تلقائياً. تأكد من صلاحية <code>actions: write</code>.');
    }
}

/* ============================================================
 *  التشغيل الرئيسي
 * ============================================================ */
const pingCycle = async () => {
    let fpHtml = null;
    if (Math.random() > 0.5) {
        await pingG2G();
        await sleep(randomInt(3000, 12000));
        fpHtml = await pingFunPay();
    } else {
        fpHtml = await pingFunPay();
        await sleep(randomInt(3000, 12000));
        await pingG2G();
    }
    return fpHtml;
};

const running = new Set();
function background(name, fn) {
    if (running.has(name)) return;
    running.add(name);
    fn().catch(e => log(`${name} error:`, e.message)).finally(() => running.delete(name));
}

(async () => {
    log('--> Starting HIGH-STEALTH keep-alive session for G2G & FunPay...');
    if (!FUNPAY_COOKIES) log('⚠️ WARNING: FUNPAY_COOKIES is missing in Action env variables!');
    if (!G2G_COOKIES) log('⚠️ WARNING: G2G_COOKIES is missing in Action env variables!');

    // عمل Ping واكتشاف كل الأقسام من https://funpay.com/en/users/20896682/
    const initialHtml = await pingCycle();
    await discoverFunPayLots(true, typeof initialHtml === 'string' ? initialHtml : null);

    log(`FunPay raise pages (${activeRaiseNodes.size}): ${[...activeRaiseNodes].join(', ')} | every ~${(RAISE_INTERVAL_MIN[0] / 60).toFixed(1)}-${(RAISE_INTERVAL_MIN[1] / 60).toFixed(1)}h`);
    log(`Telegram: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'configured ✅' : 'NOT configured (no alerts)'}`);

    if (TEST_MODE) {
        log('🧪 TEST_MODE: one cycle then exit');
        if (TELEGRAM_BOT_TOKEN && !TELEGRAM_CHAT_ID) await telegramDiscoverChatId();
        if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
            const nodesList = [...activeRaiseNodes].map(id => nodeNames.get(id) ? `• ${nodeNames.get(id)} (${id})` : `• ${id}`).join('\n');
            const ok = await sendTelegram(
                `🧪 <b>اختبار البوت: متصل بنجاح ✅</b>\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `🔗 <b>صفحة العروض:</b> <code>${FUNPAY_BASE}${FUNPAY_PROFILE_PATH}</code>\n` +
                `🔍 <b>الأقسام المكتشفة للـ Boost (${activeRaiseNodes.size}):</b>\n` +
                `<blockquote>${escapeHtml(nodesList)}</blockquote>\n` +
                `💡 أرسل <code>/lots</code> في أي وقت لتحديث القائمة فوراً.`
            );
            log(ok ? 'Telegram test message sent ✅' : 'Telegram test message FAILED ❌');
        }
        await pollRunner();
        await pollG2G();
        activeRaiseNodes.forEach(n => nextRaiseAt.set(n, 0));
        await runDueRaises();
        log('🧪 TEST_MODE finished.');
        return;
    }

    const endTime = Date.now() + 5.75 * 60 * 60 * 1000;
    const handoffAt = endTime - minutes(10);
    let handedOff = false;

    activeRaiseNodes.forEach(n => nextRaiseAt.set(n, Date.now() + minutes(randomInt(2, 12))));

    let nextPingAt = Date.now() + randomInt(240000, 420000);
    let nextRunnerAt = 0;
    let nextG2gAt = Date.now() + randomInt(5000, 20000);
    let nextDiscoverAt = Date.now() + DISCOVER_INTERVAL_MS;
    let nextTgPollAt = 0;
    let cycle = 1;

    while (Date.now() < endTime) {
        const now = Date.now();

        if (now >= nextPingAt) {
            nextPingAt = now + randomInt(240000, 420000);
            const c = cycle++;
            background('ping', async () => {
                const html = await pingCycle();
                if (typeof html === 'string') await discoverFunPayLots(false, html);
                log(`Cycle ${c} complete. Next ping in ~${((nextPingAt - Date.now()) / 60000).toFixed(1)} min.`);
            });
        }

        if (now >= nextRunnerAt) {
            nextRunnerAt = now + randomInt(...RUNNER_INTERVAL_MS) / TIME_SCALE;
            background('runner', pollRunner);
        }

        if (now >= nextG2gAt) {
            nextG2gAt = now + randomInt(...G2G_POLL_MS) / TIME_SCALE;
            background('g2g', pollG2G);
        }

        if (now >= nextDiscoverAt) {
            nextDiscoverAt = now + DISCOVER_INTERVAL_MS;
            background('discover', () => discoverFunPayLots(false));
        }

        if (now >= nextTgPollAt) {
            nextTgPollAt = now + 3500;
            background('tg-poll', pollTelegramUpdates);
        }

        if ([...activeRaiseNodes].some(n => (nextRaiseAt.get(n) || 0) <= now)) {
            background('raise', runDueRaises);
        }

        if (!handedOff && now >= handoffAt) {
            handedOff = true;
            background('handoff', relaunchSelf);
        }

        await sleep(randomInt(2000, 4000));
    }

    log('--> Stealth session finished naturally after ~5 hours and 45 minutes.');
    for (let i = 0; i < 20 && running.size; i++) await sleep(1000);
})();
