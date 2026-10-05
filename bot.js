const axios = require('axios');

const G2G_COOKIES = process.env.G2G_COOKIES;

if (!G2G_COOKIES) {
    console.error("Error: Cookies not found in Secrets!");
    process.exit(1);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    'Cookie': G2G_COOKIES,
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Upgrade-Insecure-Requests': '1',
    'Referer': 'https://www.g2g.com/'
};

const pingStore = async () => {
    try {
        const response = await axios.get('https://www.g2g.com/QuickSellPro', { headers });
        if (response.status === 200) {
            console.log(`[${new Date().toISOString()}] QuickSellPro Status: Online 🟢`);
        } else {
            console.log(`[${new Date().toISOString()}] Server responded with code: ${response.status}`);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error pinging store:`, error.response ? error.response.status : error.message);
    }
};

(async () => {
    console.log("--> Starting continuous stealth keep-alive session...");
    
    // تحديد أقصى مدة للعمل: 5 ساعات و 45 دقيقة (5.75 ساعات)
    const maxDurationMs = 5.75 * 60 * 60 * 1000; 
    const startTime = Date.now();
    const endTime = startTime + maxDurationMs;
    
    let cycle = 1;

    // السكريبت سيستمر في العمل حتى تنتهي مدة الـ 5 ساعات و 45 دقيقة
    while (Date.now() < endTime) {
        await pingStore();
        
        const remainingTimeMs = endTime - Date.now();
        if (remainingTimeMs > 0) {
            // انتظار عشوائي بين 4 دقائق و 7 دقائق
            const delayMs = randomInt(240000, 420000); 
            
            // التأكد من أن وقت الانتظار لا يتخطى الوقت المتبقي لإنهاء السكريبت
            const actualDelayMs = Math.min(delayMs, remainingTimeMs);
            const delayMinutes = (actualDelayMs / 60000).toFixed(2);
            
            console.log(`Cycle ${cycle} complete. Waiting ${delayMinutes} minutes for next ping...`);
            await sleep(actualDelayMs);
            cycle++;
        }
    }
    
    console.log("--> Session finished successfully after 5 hours and 45 minutes.");
})();
