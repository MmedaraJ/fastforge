// Step 7: one load per engine, every request on one clock, to see what the first frame waits for.
// usage: node timeline.js <2500k|fast> <licenceDelayMs> <asset> <engine>...
// Times are ms after the manifest request, where the app's startup clock starts,
// from the page's own Resource Timing entries. The preflight comes from CDP,
// which reports it as a request of its own; Resource Timing folds it into the POST.
const { chromium } = require('playwright');
const fs = require('fs');

const [profile, delayArg, asset, ...engines] = process.argv.slice(2);
const delay = Number(delayArg);
const port = process.env.PORT || 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Short names: drop the origin, the signature and the asset ID.
const short = (url) => url
  .replace(/^https?:\/\/[^/]+/, '')
  .replace(/\/t\/[^/]+\/packaged\/[^/]+\//, '…/')
  .replace(/\/assets\/[^/]+\//, '/assets/:id/');

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const out = [];
  for (const engine of engines) {
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
    if (delay > 0) {
      await page.route('**/license/**', async (route) => {
        if (route.request().method() === 'POST') await sleep(delay);
        await route.continue();
      });
    }
    // Every request on the CDP clock (seconds), preflights included.
    const seen = new Map();
    cdp.on('Network.requestWillBeSent', (e) => seen.set(e.requestId, { method: e.request.method, url: e.request.url, start: e.timestamp, end: null }));
    cdp.on('Network.loadingFinished', (e) => { const r = seen.get(e.requestId); if (r) r.end = e.timestamp; });

    await page.goto(`http://localhost:${port}/?net=test&preload=0`);
    await sleep(300);
    await page.selectOption('#abr', 'throughput');
    await page.selectOption('#engine', engine);
    await page.fill('#asset', asset);
    await page.evaluate(() => {
      performance.setResourceTimingBufferSize(1000);
      performance.clearResourceTimings();
      document.getElementById('load').addEventListener('click', () => { window.__press = performance.now(); }, true);
    });
    await page.click('#load');
    let s = null;
    for (let i = 0; i < 400; i++) {
      s = await page.evaluate(() => window.fastforge.snapshot());
      if (s && s.startupMs !== null) break;
      await sleep(50);
    }
    await sleep(200);

    const timings = await page.evaluate(() => ({
      press: window.__press,
      entries: performance.getEntriesByType('resource').map((e) => ({ name: e.name, start: e.startTime, end: e.responseEnd })),
    }));
    const manifest = timings.entries.find((e) => /master\.m3u8|manifest\.mpd/.test(e.name));
    const t0 = manifest.start;
    const rows = timings.entries
      .filter((e) => !/\.js$|\.css$|favicon/.test(e.name))
      .map((e) => ({ file: short(e.name), start: Math.round(e.start - t0), end: Math.round(e.end - t0) }));
    const licence = timings.entries.find((e) => /\/license\//.test(e.name));
    const licenceCdp = [...seen.values()].filter((r) => /\/license\//.test(r.url));
    const post = licenceCdp.find((r) => r.method === 'POST');
    const pre = licenceCdp.find((r) => r.method === 'OPTIONS');
    const preflight = pre && post
      ? { startAfterPost: Math.round((pre.start - post.start) * 1000), ms: pre.end ? Math.round((pre.end - pre.start) * 1000) : null }
      : null;
    const r = {
      engine, profile, delay, asset,
      pressBeforeManifest: Math.round(t0 - timings.press),
      firstFrame: s.startupMs,
      licence: licence ? { start: Math.round(licence.start - t0), end: Math.round(licence.end - t0) } : null,
      preflight, rows,
    };
    out.push(r);

    console.log(`\n== ${engine} ${profile} delay ${delay}: press→manifest ${r.pressBeforeManifest} ms, first frame ${r.firstFrame} ms after the manifest request`);
    if (r.licence) {
      const p = preflight ? `${preflight.ms} ms, starting ${preflight.startAfterPost} ms after the POST was issued` : 'none seen';
      console.log(`   licence ${r.licence.start}→${r.licence.end}; preflight ${p}`);
    }
    for (const x of rows.filter((x) => x.start <= s.startupMs + 50)) {
      console.log(`   ${String(x.start).padStart(5)} → ${String(x.end).padStart(5)}  ${x.file}`);
    }
    await context.close();
  }
  fs.writeFileSync(`timeline-${profile}-${delay}.json`, JSON.stringify(out, null, 1));
  await browser.close();
})();
