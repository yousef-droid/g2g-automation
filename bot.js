const axios = require('axios');

const G2G_COOKIES = process.env.G2G_COOKIES;

if (!G2G_COOKIES) {
    console.error("Error: Cookies not found in Secrets!");
    process.exit(1);
}

// دوال لإنشاء تأخير زمني عشوائي للتمويه (Stealth)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ترويسات متصفح كاملة لتقليد متصفح حقيقي (Google Chrome على Windows)
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    'Cookie': G2G_COOKIES,
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Referer': 'https://www.g2g.com/'
};

async function runPingOnly() {
    try {
        const initialDelay = randomInt(5000, 45000); 
        console.log(`Stealth Mode: Waiting ${initialDelay / 1000} seconds before pinging...`);
        await sleep(initialDelay);

        await axios.get('https://www.g2g.com/api/v1/user/ping', { headers });
        console.log("Store QuickSellPro Status: Online 🟢 - Ping sent successfully.");

    } catch (error) {
        console.error("Ping failed details:");
        if (error.response) {
            console.error(`Status Code: ${error.response.status}`);
            console.error(`Data:`, JSON.stringify(error.response.data));
        } else {
            console.error(`Message: ${error.message}`);
        }
    }
}
