// L2: dynamic landing-page triage. Renders the URL in an isolated headless
// browser and scores it on DOM/behavioral signals. NOTE: the visual-similarity
// leg of the design doc (CLIP/ResNet embedding vs. known bank login screenshots)
// is NOT implemented here — no embedding model or reference screenshot DB ships
// in this environment. See docs/LIMITATIONS.md. What *is* real: rendering the
// page in a sandbox and inspecting the DOM it actually produces.
const { OFFICIAL_DOMAINS } = require('./l1');

// Only set CHROME_PATH when Playwright can't find its own browser on its own
// (e.g. this dev sandbox, which needs an explicit path). Leave it unset
// everywhere else — `chromium.launch({executablePath: undefined})` makes
// Playwright resolve the browser it downloaded during `npm install` itself,
// which is what happens on a normal machine (Windows/Mac included). Hardcoding
// a sandbox-only path here previously broke L2 on any machine that wasn't
// this exact container.
const CHROME_PATH = process.env.CHROME_PATH || undefined;
// Dev sandboxes that route outbound HTTPS through a local MITM proxy (see
// HTTPS_PROXY) need Chromium pointed at it explicitly and TLS errors ignored
// for that proxy's re-signed certs. A real deployment has no such proxy —
// this block is a no-op there.
const PROXY_SERVER = process.env.HTTPS_PROXY || process.env.https_proxy || null;

const OVER_COLLECTING_LABELS = ['주민등록번호', '주민번호', '보안카드', '계좌비밀번호', 'OTP', '전체 번호'];

// Vercel's serverless functions don't ship a system Chromium and can't run
// Playwright's own full download (too large, wrong OS image). The standard
// workaround is playwright-core (no bundled browser) + @sparticuz/chromium
// (a prebuilt binary sized for Lambda-like runtimes). Locally (this sandbox,
// or your own machine) we keep using the full `playwright` package instead,
// which already has a real browser from `npm install`. This branch is
// implemented against the well-established pattern but has not been
// exercised against a live Vercel deployment from this session — verify
// after deploying, and see docs/LIMITATIONS.md.
async function launchBrowser() {
  if (process.env.VERCEL) {
    const { chromium } = require('playwright-core');
    const sparticuzChromium = require('@sparticuz/chromium');
    return chromium.launch({
      args: sparticuzChromium.args,
      executablePath: await sparticuzChromium.executablePath(),
      headless: true
    });
  }
  const { chromium } = require('playwright');
  return chromium.launch({
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', ...(PROXY_SERVER ? [`--proxy-server=${PROXY_SERVER}`, '--proxy-bypass-list=<local>;localhost;127.0.0.1'] : [])]
  });
}

async function analyzeLandingPage(url, { timeoutMs = 15000 } = {}) {
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S911N) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36',
      ignoreHTTPSErrors: !!PROXY_SERVER
    });
    const page = await context.newPage();
    const signals = { apkDownload: false, externalAppScheme: false, devtoolsBlocked: false, rightClickBlocked: false, overCollectingForm: false, passwordFieldCount: 0, formFieldCount: 0 };

    page.on('dialog', d => d.dismiss().catch(() => {}));

    let finalUrl = url, httpsOk = false, screenshot = null;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      finalUrl = page.url();
      httpsOk = finalUrl.startsWith('https://');
      await page.waitForTimeout(800); // let redirect chains / injected overlays settle
      screenshot = (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64');
    } catch (e) {
      await browser.close();
      return { score: 40, verdict: 'mid', reason: `render-failed:${e.message.slice(0, 120)}`, signals: null, screenshot: null, finalUrl };
    }

    const html = await page.content().catch(() => '');
    signals.apkDownload = /\.apk(["'\s?]|$)/i.test(html);
    signals.externalAppScheme = /(intent:\/\/|market:\/\/|itms-apps:\/\/)/i.test(html);
    signals.devtoolsBlocked = /(keydown[^;]{0,80}(f12|123)|contextmenu[^;]{0,80}preventDefault)/i.test(html);
    signals.rightClickBlocked = /oncontextmenu\s*=\s*["']?return\s*false/i.test(html) || /addEventListener\(\s*['"]contextmenu['"]/i.test(html);

    const inputs = await page.$$eval('input', els => els.map(e => ({ type: (e.type || '').toLowerCase(), name: (e.name || '') + ' ' + (e.placeholder || '') + ' ' + (e.id || '') })));
    signals.formFieldCount = inputs.length;
    signals.passwordFieldCount = inputs.filter(i => i.type === 'password').length;
    const joined = inputs.map(i => i.name).join(' ');
    signals.overCollectingForm = OVER_COLLECTING_LABELS.some(l => joined.includes(l)) && signals.passwordFieldCount > 0 && signals.formFieldCount >= 4;

    let host;
    try { host = new URL(finalUrl).hostname.replace(/^www\./, ''); } catch { host = ''; }
    const whitelisted = OFFICIAL_DOMAINS.has(host);

    let score = 0;
    if (!httpsOk) score += 20;
    if (signals.apkDownload) score += 35;
    if (signals.externalAppScheme) score += 25;
    if (signals.devtoolsBlocked) score += 15;
    if (signals.overCollectingForm) score += 35;
    if (whitelisted) score = 0;
    score = Math.min(100, score);
    const verdict = score >= 60 ? 'high' : score >= 30 ? 'mid' : 'low';

    await browser.close();
    return { score, verdict, whitelisted, httpsOk, finalUrl, signals, screenshot };
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

module.exports = { analyzeLandingPage };
