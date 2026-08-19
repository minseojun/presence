// Renders server/reference-pages/*.html and precomputes their perceptual
// hash into server/data/model/visual-reference.json, so L2 doesn't have to
// re-render reference pages on every request. Re-run this whenever a
// reference page changes, or (in a real deployment with network access) once
// real official-domain screenshots replace these hand-built mockups.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { computeAHash } = require('../src/visual');

const REF_DIR = path.join(__dirname, '..', 'reference-pages');
const OUT_PATH = path.join(__dirname, '..', 'data', 'model', 'visual-reference.json');
const CHROME_PATH = process.env.CHROME_PATH || undefined;

async function run() {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const refs = [];
  for (const file of fs.readdirSync(REF_DIR).filter(f => f.endsWith('.html'))) {
    const filePath = path.join(REF_DIR, file);
    await page.goto('file://' + filePath, { waitUntil: 'load' });
    const shot = await page.screenshot({ type: 'jpeg', quality: 80 });
    const hash = await computeAHash(shot);
    refs.push({ name: file.replace(/\.html$/, ''), hash });
    console.log(file, '->', hash);
  }
  await browser.close();
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ builtAt: new Date().toISOString(), note: 'Hand-built generic bank-login mockups — NOT real bank screenshots (this environment cannot reach real bank domains). See LIMITATIONS.md.', refs }, null, 2));
  console.log('wrote', OUT_PATH);
}

run().catch(e => { console.error('build failed:', e.message); process.exit(1); });
