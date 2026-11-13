// Step 7: swipe from a playing video to the preloaded next one, and time it.
// usage: node feed.js <port> <engine> <rounds> <first,second>...
// DELAY holds each licence POST that many ms. FAIL_PRELOAD=1 fails the second
// licence POST, the preloader's, to check the engine then fetches its own.
const { chromium } = require('playwright');

const [port, engine, roundsArg, ...feeds] = process.argv.slice(2);
const delay = Number(process.env.DELAY ?? 0);
const failPreload = process.env.FAIL_PRELOAD === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  for (let round = 1; round <= Number(roundsArg); round++) for (const feed of feeds) {
    const [first, second] = feed.split(',');
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 100,
      downloadThroughput: 2500 * 1000 / 8,
      uploadThroughput: 1000 * 1000 / 8,
    });
    // Only routed when needed: routing a request adds a little time of its own.
    let posts = 0;
    if (delay > 0 || failPreload) {
      await page.route('**/license/**', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        posts++;
        if (failPreload && posts === 2) return route.abort();
        if (delay > 0) await sleep(delay);
        await route.continue();
      });
    }
    const licences = [];
    page.on('request', (r) => {
      if (/\/license\//.test(r.url()) && r.method() === 'POST') licences.push(Date.now());
    });
    const log = () => page.evaluate(() => document.getElementById('log').innerText);

    await page.goto(`http://localhost:${port}/?net=test&feed=${first},${second}`);
    await sleep(400);
    await page.selectOption('#abr', 'throughput');
    await page.selectOption('#engine', engine);
    // The first video plays; wait until the second is preloaded.
    let ready = false;
    for (let i = 0; i < 160; i++) {
      if ((await log()).includes(`preloaded ${second}`)) { ready = true; break; }
      await sleep(250);
    }

    const before = licences.length;
    const press = Date.now();
    await page.click('#next');
    let s = null;
    for (let i = 0; i < 400; i++) {
      s = await page.evaluate(() => window.fastforge.snapshot());
      if (s && s.assetId === second && s.startupMs !== null) break;
      await sleep(10);
    }
    const pressToFrame = Date.now() - press;
    await sleep(300);
    const after = licences.filter((t) => t >= press);
    const first_ = after.length ? ` (first ${after[0] - press} ms after the press)` : '';
    console.log(`r${round} to ${second.slice(0, 8)} port ${port} delay ${delay}${failPreload ? ' preload licence failed' : ''}: preloaded ${ready}, ` +
      `licences before swipe ${before}, after ${after.length}${first_}; press to frame ${pressToFrame} ms, startup ${s?.startupMs} ms`);
    await context.close();
  }
  await browser.close();
})();
