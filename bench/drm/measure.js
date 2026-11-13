// Step 7: what DRM costs at startup. One cold load per run, interleaved.
// usage: node measure.js <2500k|fast> <licenceDelayMs> <rounds> <asset>... -- <engine>...
// PORT picks the web build (default 8000); TAG goes into the output file's name.
const { chromium } = require('playwright');
const fs = require('fs');

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const [profile, delayArg, roundsArg, ...assets] = argv.slice(0, sep);
const engines = argv.slice(sep + 1);
const delay = Number(delayArg);
const rounds = Number(roundsArg);
const port = process.env.PORT || 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Your test assets: the same renditions packaged three ways.
const NAMES = { 'e2f66339': 'clear', '0dd7ce6a': 'clear', 'cd7c676f': 'enc cl0', '3ac1f866': 'enc cl0', 'e24f0a5d': 'enc cl5' };

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const rows = [];
  for (let round = 1; round <= rounds; round++) for (const asset of assets) for (const engine of engines) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 100,
      downloadThroughput: (profile === 'fast' ? 50000 : 2500) * 1000 / 8,
      uploadThroughput: 1000 * 1000 / 8,
    });
    // A slow licence server: hold each licence POST before letting it through.
    if (delay > 0) {
      await page.route('**/license/**', async (route) => {
        if (route.request().method() === 'POST') await sleep(delay);
        await route.continue();
      });
    }

    // Licence requests, in ms after the press.
    const licences = [];
    let press = 0;
    page.on('request', (r) => {
      if (/\/license\//.test(r.url()) && r.method() === 'POST') licences.push({ start: Date.now() - press, end: null, r });
    });
    page.on('requestfinished', (r) => {
      const l = licences.find((x) => x.r === r);
      if (l) l.end = Date.now() - press;
    });

    await page.goto(`http://localhost:${port}/?net=test&preload=0`);
    await sleep(300);
    await page.evaluate(() => {
      window.__wfk = 0;
      document.querySelector('video').addEventListener('waitingforkey', () => window.__wfk++);
    });
    await page.selectOption('#abr', 'throughput');
    await page.selectOption('#engine', engine);
    await page.fill('#asset', asset);
    press = Date.now();
    await page.click('#load');

    // startupMs is the app's own number: manifest request to first frame.
    let s = null;
    for (let i = 0; i < 300; i++) {
      s = await page.evaluate(() => window.fastforge.snapshot());
      if (s && s.startupMs !== null) break;
      await sleep(50);
    }
    const pressToFrame = Date.now() - press;
    const wfk = await page.evaluate(() => window.__wfk);
    const row = {
      round, asset: NAMES[asset.slice(0, 8)], engine, startup: s?.startupMs ?? null, pressToFrame,
      licences: licences.length, licStart: licences[0]?.start ?? null, licEnd: licences[0]?.end ?? null, waitingforkey: wfk,
    };
    rows.push(row);
    const lic = row.licences ? `${row.licStart}→${row.licEnd} ms after press` : 'none';
    console.log(`r${round} ${row.asset.padEnd(8)} ${engine.padEnd(10)} startup ${String(row.startup).padStart(5)} ms  licence ${lic}  waitingforkey ${wfk}`);
    await context.close();
  }
  fs.writeFileSync(`m${process.env.TAG || ''}-${profile}-${delay}.json`, JSON.stringify(rows, null, 1));
  await browser.close();
})();
