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

(async () => {
    try {
        console.log("--> Bot execution started for QuickSellPro...");
        
        const initialDelay = randomInt(3000, 8000); 
        console.log(`Stealth Mode: Waiting ${initialDelay / 1000} seconds before pinging...`);
        await sleep(initialDelay);

        // زيارة صفحة متجرك المباشرة للتحقق من الجلسة وبقائها نشطة
        const response = await axios.get('https://www.g2g.com/QuickSellPro', { headers });
        
        if (response.status === 200) {
            console.log("Store QuickSellPro Status: Online 🟢 - Profile session updated successfully!");
            console.log(`Server Response Code: ${response.status}`);
        } else {
            console.log(`Received status code: ${response.status}`);
        }

    } catch (error) {
        console.error("Execution failed details:");
        if (error.response) {
            console.error(`Status Code: ${error.response.status}`);
            if (error.response.status === 401 || error.response.status === 403) {
                console.error("Reason: Session expired or blocked by Cloudflare/Cookies.");
            }
        } else {
            console.error(`Error Message: ${error.message}`);
        }
    }
})();
