'use strict';
const axios = require('axios');

/* ============================================================
 *  الإعدادات (Config)
 * ============================================================ */
const G2G_COOKIES = process.env.G2G_COOKIES;
const FUNPAY_COOKIES = process.env.FUNPAY_COOKIES;

const FUNPAY_BASE = (process.env.FUNPAY_BASE || 'https://funpay.com').replace(/\/$/, '');
const FUNPAY_USERNAME = process.env.FUNPAY_USERNAME || 'QuickSellProo';

// الصفحات (الرقم اللي في الرابط /lots/<رقم>/trade) اللي هيتعملها Boost
const RAISE_NODES = (process.env.FUNPAY_RAISE_NODES || '47,3050,139')
    .split(',').map(s => s.trim()).filter(Boolean);

// اختياري: لو السكربت ماعرفش يلاقي game_id تلقائياً. الصيغة: "47:41,3050:12"
const GAME_ID_OVERRIDES = Object.fromEntries(
    (process.env.FUNPAY_GAME_IDS || '').split(',').map(s => s.trim().split(':')).filter(p => p.length === 2)
);

// الفاصل بين كل Boost والتاني (بالدقائق) - عشوائي حوالي 3 ساعات
const RAISE_INTERVAL_MIN = [165, 205];
// كل قد إيه نسأل FunPay عن المبيعات/الرسائل (وده كمان اللي بيخلي الحساب "Online")
const RUNNER_INTERVAL_MS = [35000, 65000];

const TEST_MODE = process.env.TEST_MODE === 'true';
const TIME_SCALE = Number(process.env.TIME_SCALE || 1); // للاختبار المحلي فقط

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
const asJson = (d) => {
    if (d && typeof d === 'object') return d;
    try { return JSON.parse(d); } catch { return null; }
};

/* ---------- Telegram ---------- */
async function sendTelegram(text) {
    log(`📨 ${text.split('\n')[0]}`);
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
    try {
        await axios.post(`${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text,
            disable_web_page_preview: true
        }, { timeout: 15000 });
        return true;
    } catch (e) {
        log('Telegram send failed:', e.response ? JSON.stringify(e.response.data) : e.message);
        return false;
    }
}

// تنبيهات الأخطاء: مرة واحدة بس لحد ما المشكلة تتحل (عشان مفيش سبام)
const activeAlerts = new Set();
async function alertOnce(key, text) {
    if (activeAlerts.has(key)) return;
    activeAlerts.add(key);
    await sendTelegram(text);
}
const clearAlert = (key) => activeAlerts.delete(key);

// بيساعدك تعرف TELEGRAM_CHAT_ID: ابعت أي رسالة للبوت وبعدين شغّل test_mode
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
// هيدرز طلبات الـ XHR (زي اللي المتصفح بيبعتها من جوه الصفحة)
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
 *  G2G (زي ما كان)
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
 *  FunPay
 * ============================================================ */

// كوكيز بتتحدث تلقائياً من Set-Cookie (عشان الجلسة PHPSESSID ما تنتهيش)
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
    return html.includes(FUNPAY_USERNAME); // الفحص القديم كاحتياطي
}

// بيانات الجلسة (رقم حسابك + csrf) اللي محتاجها طلبات الـ runner
const ctx = { userId: null, csrf: null };

// بيحمّل الصفحة الرئيسية، يتأكد إن الحساب داخل، ويحدّث بيانات الجلسة
async function loadFunPaySession() {
    const res = await fp('get', '/');
    const html = String(res.data);
    if (res.status !== 200) return { ok: false, status: res.status };
    const app = parseAppData(html);
    if (!isLoggedIn(html, app)) return { ok: false, status: 200, loggedOut: true };
    if (app) {
        if (Number(app.userId) > 0) ctx.userId = String(app.userId);
        if (app['csrf-token']) ctx.csrf = app['csrf-token'];
    }
    return { ok: true };
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
            return true;
        } else if (r.loggedOut) {
            log('FunPay Error: Cookies Expired / Logged Out 🔴');
            await alertOnce('funpay-logout', '🔴 FunPay: الكوكيز انتهت / الحساب اتفصل.\nحدّث FUNPAY_COOKIES في GitHub Secrets.');
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
    sellers: null,            // عدد المبيعات النشطة (null = لسه ماقرأناش)
    chat: null, chatMsg: null,
    bookTag: randomTag(),
    bookmarksOk: false,       // true لما نقدر نقرا نص الرسائل (chat_bookmarks)
    fails: 0
};
const chatSeen = new Map();   // chatId -> آخر رسالة اتعاملنا معاها
let bookBaseline = false;
const seenOrders = new Set();

// بيقرأ صفحة المبيعات ويطلّع الطلبات المدفوعة (best-effort، لو شكل الصفحة اتغير بيرجع [])
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
            await sendTelegram(
                `🛒 FunPay: عملية بيع جديدة!\n` +
                `#${s.id}${s.price ? ` — ${s.price}` : ''}\n` +
                `${s.desc ? s.desc + '\n' : ''}` +
                `${s.buyer ? 'المشتري: ' + s.buyer + '\n' : ''}` +
                `${FUNPAY_BASE}/en/orders/${s.id}/`);
        }
    } else if (now > prev) {
        // العدّاد زاد بس ماعرفناش نقرأ تفاصيل الطلب
        await sendTelegram(`🛒 FunPay: في عملية بيع جديدة (عدد المبيعات النشطة: ${now})\n${FUNPAY_BASE}/en/orders/trade`);
    }
}

async function onOrdersCounters(d) {
    const seller = Number(d.seller) || 0;
    const prev = rs.sellers;
    rs.sellers = seller;
    if (prev === null) {                 // أول قراءة: baseline بدون تنبيه
        log(`FunPay sales counter: ${seller}`);
        if (seller > 0) await checkNewSales({ silent: true });
        return;
    }
    if (seller !== prev) await checkNewSales({ silent: false, prev, now: seller });
}


// بيقرا قايمة المحادثات (بنفس شكل اللي بتشوفه في صفحة Chat) ويطلّع الرسائل الجديدة بنصها
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
    if (!bookBaseline) {                 // أول قراءة: baseline بدون تنبيه
        bookBaseline = true;
        contacts.forEach(c => chatSeen.set(c.id, c.nodeMsg));
        return;
    }
    for (const c of contacts) {
        const seen = chatSeen.get(c.id);
        chatSeen.set(c.id, c.nodeMsg);
        if (c.unread && c.nodeMsg && c.nodeMsg !== seen) {
            const text = c.text.length > 600 ? c.text.slice(0, 600) + '…' : c.text;
            await sendTelegram(
                `💬 FunPay: رسالة من ${c.name || 'مستخدم'}\n` +
                `${text || '(بدون نص)'}\n` +
                `${FUNPAY_BASE}/en/chat/?node=${c.id}`);
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
    if (prev === null) {                 // أول قراءة: baseline بدون تنبيه
        log(`FunPay unread chats: ${counter}`);
        return;
    }
    if (!rs.bookmarksOk && counter > 0 && (counter > prev || msgId !== prevMsg)) {
        await sendTelegram(`💬 FunPay: رسالة جديدة (غير مقروءة: ${counter})\n${FUNPAY_BASE}/en/chat/`);
    }
}

async function pollRunner() {
    if (!FUNPAY_COOKIES) return;
    try {
        if (!ctx.userId || !ctx.csrf) {
            const r = await loadFunPaySession();
            if (!r.ok || !ctx.userId) throw new Error(r.loggedOut ? 'logged out' : 'no session data');
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
            ctx.csrf = null; // نجدد الجلسة في المحاولة الجاية
            throw new Error(`bad runner response (HTTP ${res.status})`);
        }
        const book = json.objects.find(o => o.type === 'chat_bookmarks');
        if (book) { if (book.tag) rs.bookTag = book.tag; await onChatBookmarks(book.data || {}); }
        for (const o of json.objects) {
            if (o.type === 'orders_counters') { if (o.tag) rs.ordersTag = o.tag; await onOrdersCounters(o.data || {}); }
            else if (o.type === 'chat_counter') { if (o.tag) rs.chatTag = o.tag; await onChatCounter(o.data || {}); }
        }
        if (rs.fails >= 5) await sendTelegram('🟢 FunPay: الاتصال رجع طبيعي.');
        rs.fails = 0;
        clearAlert('runner-fail');
    } catch (e) {
        rs.fails++;
        log(`runner error (${rs.fails}): ${e.message}`);
        if (rs.fails >= 5) {
            await alertOnce('runner-fail', `⚠️ FunPay: فشل الاتصال ${rs.fails} مرات ورا بعض (${e.message}).\nممكن الحساب يظهر Offline، راجع الكوكيز.`);
        }
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

// يفهم رسالة الانتظار: "Please wait 3 hours" / "Подождите 28 минут" ... الخ
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

// يضغط "Boost offers" لصفحة واحدة. بيرجع { ok, nextInMs, fatal }
async function raiseNode(nodeId) {
    const tradePath = `/en/lots/${nodeId}/trade`;
    const page = await fp('get', tradePath);
    if (page.status !== 200) {
        log(`Raise[${nodeId}] ✗ trade page HTTP ${page.status}`);
        return { ok: false, nextInMs: minutes(randomInt(15, 30)) };
    }
    const html = String(page.data);
    const app = parseAppData(html);
    if (!isLoggedIn(html, app)) {
        log(`Raise[${nodeId}] ✗ logged out 🔴`);
        return { ok: false, fatal: true, nextInMs: minutes(60) };
    }

    const gameId = GAME_ID_OVERRIDES[nodeId] || findGameId(html);
    if (!gameId) {
        log(`Raise[${nodeId}] ✗ game_id not found in page. (حط FUNPAY_GAME_IDS="${nodeId}:<game_id>")`);
        await alertOnce(`gameid-${nodeId}`, `⚠️ FunPay: مش قادر ألاقي game_id للصفحة ${nodeId}. شوف الـ logs.`);
        return { ok: false, nextInMs: minutes(randomInt(60, 90)) };
    }

    await sleep(randomInt(2000, 7000)); // تأخير بشري قبل "الضغط"

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

    // أحياناً بيرجع نافذة اختيار فئات (modal) → نختار الفئة بتاعتنا بس
    if (json && json.modal) {
        const ids = [...String(json.modal).matchAll(/<input[^>]*name="node_ids\[\]"[^>]*>/g)]
            .map(m => (m[0].match(/value="(\d+)"/) || [])[1]).filter(Boolean);
        if (ids.length && !ids.includes(String(nodeId))) {
            log(`Raise[${nodeId}] ⚠ modal لا يحتوي الفئة دي، الموجود: ${ids.join(',')}`);
        }
        await sleep(randomInt(1500, 4000));
        res = await postRaise([['node_ids[]', String(nodeId)]]);
        json = asJson(res.data);
    }

    if (!json) {
        log(`Raise[${nodeId}] ✗ unexpected response (HTTP ${res.status}): ${stripTags(res.data).slice(0, 200)}`);
        return { ok: false, nextInMs: minutes(randomInt(30, 60)) };
    }

    const msg = stripTags(json.msg || '');
    if (json.error || json.url) {
        const waitMs = parseWaitMs(msg);
        if (waitMs) {
            log(`Raise[${nodeId}] ⏳ cooldown (game_id=${gameId}): "${msg}"`);
            return { ok: false, nextInMs: waitMs + minutes(randomInt(1, 6)) };
        }
        log(`Raise[${nodeId}] ✗ FunPay said: "${msg}"`);
        return { ok: false, nextInMs: minutes(randomInt(30, 50)) };
    }

    log(`Raise[${nodeId}] ✅ boosted (game_id=${gameId})${msg ? ` — "${msg}"` : ''}`);
    return { ok: true, nextInMs: minutes(randomInt(...RAISE_INTERVAL_MIN)) };
}

const nextRaiseAt = new Map();

async function runDueRaises() {
    if (!FUNPAY_COOKIES) return;
    const due = shuffle(RAISE_NODES.filter(n => (nextRaiseAt.get(n) || 0) <= Date.now()));
    for (let i = 0; i < due.length; i++) {
        const node = due[i];
        try {
            const r = await raiseNode(node);
            nextRaiseAt.set(node, Date.now() + r.nextInMs);
            if (r.fatal) {
                await alertOnce('funpay-logout', '🔴 FunPay: الكوكيز انتهت، مفيش Boost هيحصل. حدّث FUNPAY_COOKIES.');
                RAISE_NODES.forEach(n => nextRaiseAt.set(n, Date.now() + r.nextInMs));
                return;
            }
            log(`Raise[${node}] next attempt in ~${(r.nextInMs / 3600000).toFixed(2)}h`);
        } catch (e) {
            log(`Raise[${node}] ✗ error: ${e.message}`);
            nextRaiseAt.set(node, Date.now() + minutes(randomInt(15, 30)));
        }
        if (i < due.length - 1) await sleep(randomInt(25000, 90000)); // فاصل عشوائي بين الصفحات
    }
}


/* ============================================================
 *  G2G: تنبيهات المبيعات (نفس الطلب اللي الجرس في الموقع بيستخدمه)
 * ============================================================ */
const G2G_USER_ID = process.env.G2G_USER_ID || '1002988142';
const G2G_API = (process.env.G2G_API || 'https://sls.g2g.com').replace(/\/$/, '');
// اختياري: رابط list_my_order الكامل (من Network) عشان نضيف الكمية والسعر في التنبيه
const G2G_LIST_ORDER_URL = process.env.G2G_LIST_ORDER_URL;
const G2G_POLL_MS = [90000, 150000];
// تجديد التوكن تلقائياً (اتأكد من اللوج الأول، شوف README)
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

// أسماء الحقول فقط (من غير أي قيم) عشان التشخيص
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

// تجديد التوكن بنفس طريقة الموقع: POST /user/refresh_access (بيشتغل بس لو G2G_AUTO_REFRESH=true)
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
    const stale = g2g.token || process.env.G2G_ACCESS_TOKEN; // الموقع بيبعت آخر توكن خلص في Authorization
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

    // لو السيرفر رجّع مفاتيح تجديد جديدة نستخدمها ونحذّرك (الـ Secret ممكن يبقى قديم)
    const strs = collectStrings(res.data);
    for (const k of ['refresh_token', 'long_lived_token', 'active_device_token']) {
        if (strs[k] && strs[k] !== val(k)) {
            g2gJar.map.set(k, strs[k]);
            await alertOnce(`g2g-rotated-${k}`,
                `⚠️ G2G: السيرفر بيغيّر ${k} مع كل تجديد.\nالبوت هيكمل بالجديد في التشغيل ده، لكن لازم نحفظه بين التشغيلات (قولي).`);
        }
    }
    return pickJwt(typeof res.data === 'string' ? res.data : JSON.stringify(res.data), 'refresh_access');
}

// بيدور على توكن صالح (بدون ما يطبعه في اللوج أبداً)
async function discoverG2gToken() {
    if (Date.now() < g2g.retryAt) return false;       // استنى بعد آخر فشل
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
    if (res.status === 401 || res.status === 403) g2g.token = null; // نجرب نجيب توكن جديد المرة الجاية
    return res;
}

// بيجيب الكمية والسعر للطلبات الجديدة (لو G2G_LIST_ORDER_URL متحدد)
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
    let line = `الكمية: ${r.purchased_qty} | السعر: ${r.offer_amount} ${r.offer_currency}`;
    if (r.checkout_currency && r.checkout_currency !== r.offer_currency) {
        line += ` (المشتري دفع ${r.amount} ${r.checkout_currency})`;
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

        if (!g2g.baseline) {                       // أول قراءة: baseline بدون تنبيه
            g2g.baseline = true;
            g2g.cancel = cancel;
            log(`G2G notifications: sold=${sold.length} purchases=${bought.length} cancellations=${cancel}`);
        } else {
            if (fresh.length) {
                const details = await g2gOrderDetails();
                for (const o of fresh) {
                    const head = o.kind === 'sold' ? '🛒 G2G: عملية بيع جديدة!' : '🧾 G2G: تحديث على طلب شراء';
                    await sendTelegram(`${head}\n#${o.id}\n${o.title || ''}\n${g2gDetailLine(details[o.id])}${o.url || ''}`);
                }
            }
            if (cancel > g2g.cancel) {
                await sendTelegram(`⚠️ G2G: في طلب إلغاء جديد (العدد: ${cancel})\nhttps://www.g2g.com/g2g-user/sale`);
            }
            g2g.cancel = cancel;
        }
        if (g2g.fails >= 5) await sendTelegram('🟢 G2G: الاتصال رجع طبيعي.');
        g2g.fails = 0;
        clearAlert('g2g-fail');
    } catch (e) {
        g2g.fails++;
        log(`G2G poll error (${g2g.fails}): ${e.message}`);
        if (g2g.fails >= 5) {
            await alertOnce('g2g-fail', `⚠️ G2G: مش قادر أقرا الإشعارات (${e.message}).\nغالباً التوكن/الكوكيز محتاجة تحديث.`);
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
        await alertOnce('handoff', '⚠️ فشل تشغيل النسخة الجاية تلقائياً. تأكد إن الـ workflow عنده permissions: actions: write.');
    }
}

/* ============================================================
 *  التشغيل الرئيسي
 * ============================================================ */
const pingCycle = async () => {
    // ترتيب عشوائي + فواصل عشوائية لمنع اكتشاف النمط
    if (Math.random() > 0.5) {
        await pingG2G();
        await sleep(randomInt(3000, 12000));
        await pingFunPay();
    } else {
        await pingFunPay();
        await sleep(randomInt(3000, 12000));
        await pingG2G();
    }
};

// بيشغل مهمة في الخلفية من غير ما يوقف باقي الحلقة (عشان الـ runner مايتأخرش أبداً)
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
    log(`FunPay raise pages: ${RAISE_NODES.join(', ')} | every ~${(RAISE_INTERVAL_MIN[0] / 60).toFixed(1)}-${(RAISE_INTERVAL_MIN[1] / 60).toFixed(1)}h`);
    log(`Telegram: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'configured ✅' : 'NOT configured (no alerts)'}`);

    if (TEST_MODE) {
        log('🧪 TEST_MODE: one cycle then exit');
        if (TELEGRAM_BOT_TOKEN && !TELEGRAM_CHAT_ID) await telegramDiscoverChatId();
        if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
            const ok = await sendTelegram('🧪 اختبار: تيليجرام متوصل بالبوت بنجاح ✅');
            log(ok ? 'Telegram test message sent ✅' : 'Telegram test message FAILED ❌');
        }
        await pingCycle();
        await pollRunner();
        await pollG2G();
        RAISE_NODES.forEach(n => nextRaiseAt.set(n, 0));
        await runDueRaises();
        log('🧪 TEST_MODE finished.');
        return;
    }

    // مدة التشغيل: 5 ساعات و 45 دقيقة
    const endTime = Date.now() + 5.75 * 60 * 60 * 1000;
    const handoffAt = endTime - minutes(10);
    let handedOff = false;

    // أول محاولة Boost بعد دقايق قليلة من بداية التشغيل (لو FunPay قال استنى، هنفهم المدة ونأجل)
    RAISE_NODES.forEach(n => nextRaiseAt.set(n, Date.now() + minutes(randomInt(2, 12))));

    let nextPingAt = 0;
    let nextRunnerAt = 0;
    let nextG2gAt = Date.now() + randomInt(5000, 20000);
    let cycle = 1;

    while (Date.now() < endTime) {
        const now = Date.now();

        if (now >= nextPingAt) {
            nextPingAt = now + randomInt(240000, 420000); // 4 إلى 7 دقائق
            const c = cycle++;
            background('ping', async () => {
                await pingCycle();
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

        if (RAISE_NODES.some(n => (nextRaiseAt.get(n) || 0) <= now)) {
            background('raise', runDueRaises);
        }

        if (!handedOff && now >= handoffAt) {
            handedOff = true;
            background('handoff', relaunchSelf);
        }

        await sleep(randomInt(3000, 6000));
    }

    log('--> Stealth session finished naturally after ~5 hours and 45 minutes.');
    // نستنى أي مهمة شغالة تخلص بسرعة
    for (let i = 0; i < 20 && running.size; i++) await sleep(1000);
})();
