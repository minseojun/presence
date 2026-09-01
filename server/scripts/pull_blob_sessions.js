// The local training pipeline (../../scripts/train_l3_model.js and friends)
// only ever reads server/data/sessions/ on the local filesystem — it has no
// idea Vercel Blob exists. So sessions collected via the deployed public URL
// (stored in Blob, see server/src/store.js) need to be pulled down here
// before training locally.
// Usage: BLOB_READ_WRITE_TOKEN=... node server/scripts/pull_blob_sessions.js
// (copy the token from Vercel project settings > Storage > your Blob store
// > "Quickstart" / ".env.local" tab)
const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = path.join(__dirname, '..', 'data', 'sessions');
const BLOB_PREFIX = 'sessions/';

async function run() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('BLOB_READ_WRITE_TOKEN env var required — copy it from the Vercel dashboard: project > Storage > (your Blob store) > .env.local tab.');
    process.exit(1);
  }
  const { list } = require('@vercel/blob');
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  const { blobs } = await list({ prefix: BLOB_PREFIX });
  console.log(`found ${blobs.length} session(s) in Blob storage`);

  let written = 0, skipped = 0;
  for (const b of blobs) {
    const name = b.pathname.slice(BLOB_PREFIX.length);
    const dest = path.join(SESSIONS_DIR, name);
    if (fs.existsSync(dest)) { skipped++; continue; } // never overwrite what's already local
    const r = await fetch(b.url);
    if (!r.ok) { console.warn(`skip ${name}: fetch failed (${r.status})`); continue; }
    fs.writeFileSync(dest, await r.text());
    written++;
  }
  console.log(`wrote ${written} new session file(s), skipped ${skipped} already-local file(s) -> ${path.relative(process.cwd(), SESSIONS_DIR)}`);
}

run().catch(e => { console.error('pull failed:', e.message); process.exit(1); });
