// Minimal file-backed persistence — enough to make the "수집" tab and the
// training pipeline talk to something real. Swap for a real DB before
// production; there is no auth/multi-tenant concern yet (see LIMITATIONS.md).
const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = path.join(__dirname, '..', 'data', 'sessions');
// Serverless platforms (Vercel) ship this directory read-only as part of the
// deployment bundle; mkdirSync on an already-existing path is a no-op, but
// guard anyway so a missing dir there doesn't crash every cold start. Actual
// writes (saveSession) are gated off entirely on Vercel — see app.js.
try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch (_) {}

function saveSession(record) {
  const id = `${record.meta?.label || 'unlabeled'}_${record.meta?.participant || 'anon'}_${Date.now()}`;
  const file = path.join(SESSIONS_DIR, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return { id, file };
}

function listSessions() {
  return fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
}

module.exports = { saveSession, listSessions, SESSIONS_DIR };
