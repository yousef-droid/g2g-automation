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
    console.log("--> Starting randomized stealth keep-alive session...");
    
    // عدد دورات بين 6 و 8 لتغطية مدة تتراوح بين 40 إلى 50 دقيقة
    const totalCycles = randomInt(6, 8);
    
    for (let i = 1; i <= totalCycles; i++) {
        await pingStore();
        
        if (i < totalCycles) {
            // انتظار عشوائي بين 4 دقائق و 7 دقائق
            const delayMs = randomInt(240000, 420000); 
            const delayMinutes = (delayMs / 60000).toFixed(2);
            
            console.log(`Cycle ${i}/${totalCycles} complete. Waiting ${delayMinutes} minutes for next ping...`);
            await sleep(delayMs);
        }
    }
    
    console.log("--> Session finished naturally. Handing over to next trigger.");
})();
