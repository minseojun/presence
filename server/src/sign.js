// Signs risk decisions so a client can't fabricate a "pass" locally.
// A real deployment would use a bank-side key management service; this is an
// HMAC placeholder that proves the pattern — the client never computes or
// self-certifies the verdict, it only displays what the server signed.
const crypto = require('crypto');

const SECRET = process.env.PRESENCE_SIGNING_SECRET || 'dev-only-insecure-secret-replace-in-production';

function signDecision(payload) {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  return { payload, signature: sig };
}

function verifyDecision(payload, signature) {
  const expected = Buffer.from(crypto.createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex'), 'hex');
  let given;
  try { given = Buffer.from(String(signature || ''), 'hex'); } catch { return false; }
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

module.exports = { signDecision, verifyDecision };
