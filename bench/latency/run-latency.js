// G1 latency harness runner — Chrome headless vía puppeteer-core.
// Uso: node run-latency.js '<page-url-con-query>'
// Imprime el JSON de window.__RESULT a stdout.
const puppeteer = require('puppeteer-core');

(async () => {
  const url = process.argv[2];
  if (!url) { console.error('uso: node run-latency.js <url>'); process.exit(2); }
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  const page = await browser.newPage();
  page.on('console', (m) => process.stderr.write('[page] ' + m.text() + '\n'));
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__RESULT !== undefined', { timeout: 180000 });
  const result = await page.evaluate('window.__RESULT');
  console.log(JSON.stringify(result));
  await browser.close();
})().catch((e) => { console.error('runner error:', e.message); process.exit(1); });
