const axios = require('axios');

const G2G_COOKIES = process.env.G2G_COOKIES;
const FUNPAY_COOKIES = process.env.FUNPAY_COOKIES;

if (!G2G_COOKIES && !FUNPAY_COOKIES) {
    console.error("Error: No cookies found for any store in Secrets!");
    process.exit(1);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// بصمة متصفح كاملة لـ G2G
const g2gHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    'Cookie': G2G_COOKIES,
    'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Referer': 'https://www.g2g.com/'
};

// بصمة متصفح كاملة لـ FunPay
const funpayHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8,ar;q=0.7',
    'Cookie': FUNPAY_COOKIES,
    'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Referer': 'https://funpay.com/'
};

const pingG2G = async () => {
    if (!G2G_COOKIES) {
        console.log(`[${new Date().toISOString()}] G2G skipped: G2G_COOKIES missing`);
        return;
    }
    try {
        const response = await axios.get('https://www.g2g.com/QuickSellPro', { headers: g2gHeaders });
        if (response.status === 200) {
            console.log(`[${new Date().toISOString()}] G2G Status: Online 🟢`);
        } else {
            console.log(`[${new Date().toISOString()}] G2G Response Code: ${response.status}`);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error pinging G2G:`, error.response ? error.response.status : error.message);
    }
};

const pingFunPay = async () => {
    if (!FUNPAY_COOKIES) {
        console.log(`[${new Date().toISOString()}] FunPay skipped: FUNPAY_COOKIES missing`);
        return;
    }
    try {
        const response = await axios.get('https://funpay.com/', { headers: funpayHeaders });
        if (response.status === 200) {
            console.log(`[${new Date().toISOString()}] FunPay Status: Online 🟢`);
        } else {
            console.log(`[${new Date().toISOString()}] FunPay Response Code: ${response.status}`);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error pinging FunPay:`, error.response ? error.response.status : error.message);
    }
};

(async () => {
    console.log("--> Starting HIGH-STEALTH keep-alive session for G2G & FunPay...");

    if (!FUNPAY_COOKIES) {
        console.log("⚠️ WARNING: FUNPAY_COOKIES is missing in Action env variables!");
    }
    if (!G2G_COOKIES) {
        console.log("⚠️ WARNING: G2G_COOKIES is missing in Action env variables!");
    }

    // مدة التشغيل: 5 ساعات و 45 دقيقة
    const maxDurationMs = 5.75 * 60 * 60 * 1000; 
    const startTime = Date.now();
    const endTime = startTime + maxDurationMs;
    
    let cycle = 1;

    while (Date.now() < endTime) {
        // عشوائية ترتيب الزيارة وفواصل زمنية بين المواقع لمنع اكتشاف النمط
        if (Math.random() > 0.5) {
            await pingG2G();
            await sleep(randomInt(3000, 12000)); // فاصل عشوائي بين 3 إلى 12 ثانية
            await pingFunPay();
        } else {
            await pingFunPay();
            await sleep(randomInt(3000, 12000));
            await pingG2G();
        }
        
        const remainingTimeMs = endTime - Date.now();
        if (remainingTimeMs > 0) {
            // انتظار عشوائي بين 4 إلى 7 دقائق بين كل دورة
            const delayMs = randomInt(240000, 420000); 
            const actualDelayMs = Math.min(delayMs, remainingTimeMs);
            const delayMinutes = (actualDelayMs / 60000).toFixed(2);
            
            console.log(`Cycle ${cycle} complete. Waiting ${delayMinutes} minutes for next cycle...`);
            await sleep(actualDelayMs);
            cycle++;
        }
    }
    
    console.log("--> Stealth session finished naturally after ~5 hours and 45 minutes.");
})();
