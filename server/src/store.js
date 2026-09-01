// Session persistence. Local dev (npm start on your own machine) always
// writes to the local filesystem — collecting real phone data is a local
// workflow anyway (see README), so this path never needs Blob storage.
//
// On Vercel, the filesystem is read-only, so writes there use Vercel Blob
// instead — IF a Blob store is connected to the project (which auto-injects
// BLOB_READ_WRITE_TOKEN; see README's "데이터 저장 (Vercel Blob)" section
// for the one-time dashboard setup). If no Blob store is connected,
// app.js returns a clear 501 instead of silently losing the recording.
const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = path.join(__dirname, '..', 'data', 'sessions');
try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch (_) {}

const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_PREFIX = 'sessions/';
const BLOB_TIMEOUT_MS = 10_000;
// Vercel Blob stores are created as either Public or Private (chosen once,
// in the dashboard, when the store is created) and every put()/get() call
// must match that store's mode exactly — 'public' against a Private store
// errors with "cannot use public access on a private store". There's no way
// to introspect which mode a store is from the token alone, so this is
// configurable rather than guessed; 'private' is the default since a
// Vercel-dashboard-created store defaults to Private and, for data this
// sensitive (raw touch/motion recordings), private is the right choice
// anyway — session content should never be reachable via a guessable URL.
const BLOB_ACCESS = process.env.PRESENCE_BLOB_ACCESS === 'public' ? 'public' : 'private';

function makeId(record) {
  return `${record.meta?.label || 'unlabeled'}_${record.meta?.participant || 'anon'}_${Date.now()}`;
}

// A bad/expired token or a network hiccup can leave the underlying Blob
// SDK call pending indefinitely (observed directly while testing this: a
// fake token produced no error and no response at all). Race it against a
// timeout so a storage problem always surfaces as a clear rejection instead
// of hanging the Express request forever.
function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Blob ${label} timed out after ${BLOB_TIMEOUT_MS}ms — check BLOB_READ_WRITE_TOKEN is valid`)), BLOB_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function saveSession(record) {
  const id = makeId(record);
  if (useBlob) {
    const { put } = require('@vercel/blob');
    await withTimeout(put(`${BLOB_PREFIX}${id}.json`, JSON.stringify(record, null, 2), {
      access: BLOB_ACCESS, addRandomSuffix: false, contentType: 'application/json'
    }), 'put');
    return { id };
  }
  const file = path.join(SESSIONS_DIR, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return { id, file };
}

async function listSessions() {
  if (useBlob) {
    const { list } = require('@vercel/blob');
    const { blobs } = await withTimeout(list({ prefix: BLOB_PREFIX }), 'list');
    return blobs.map(b => b.pathname.slice(BLOB_PREFIX.length));
  }
  return fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
}

// Filenames are server-generated (makeId()), but this still accepts a
// caller-supplied id (from a URL param) — reject anything that isn't a
// plain "<label>_<participant>_<timestamp>.json" segment before touching
// the filesystem or Blob, so a crafted id can't path-traverse or address a
// different Blob prefix.
const SAFE_ID = /^[A-Za-z0-9_.-]+\.json$/;

async function getSession(filename) {
  if (!SAFE_ID.test(filename)) return null;
  if (useBlob) {
    const { get } = require('@vercel/blob');
    const result = await withTimeout(get(`${BLOB_PREFIX}${filename}`, { access: BLOB_ACCESS }), 'get');
    if (!result?.stream) return null;
    return JSON.parse(await new Response(result.stream).text());
  }
  const file = path.join(SESSIONS_DIR, filename);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = { saveSession, listSessions, getSession, SESSIONS_DIR, useBlob, BLOB_ACCESS };
