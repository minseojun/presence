const express = require('express');
const path = require('path');
const crypto = require('crypto');
const risk = require('./risk');
const { scoreDomain } = require('./l1');
const { analyzeLandingPage } = require('./l2');
const { signDecision, verifyDecision } = require('./sign');
const { saveSession, listSessions } = require('./store');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const DECISION_TTL_MS = 60_000;
// Real Android Chrome devicemotion readings for an actual light-to-moderate
// hand shake mostly land in the ~5-10 m/s^2 range (gravity already excluded
// by e.acceleration). 13 was too high — a "gentle shake" per the UI copy
// rarely cleared it, so the challenge failed even when the user complied.
const SHAKE_NEED = 7;
const SHAKE_HITS_REQUIRED = 4; // was 8 — same reasoning, must match client visual

// ---- L1: static link triage ----
app.post('/api/l1/check', (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  res.json(scoreDomain(url));
});

// ---- L2: dynamic landing-page triage ----
app.post('/api/l2/check', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const result = await analyzeLandingPage(url);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: 'render-error', message: e.message });
  }
});

// ---- L3/L4: server-authoritative session risk decision ----
// Client sends RAW telemetry only. Score, thresholds and the pass/challenge/
// block decision are computed here — a compromised client can send fake
// telemetry, but it can no longer forge the verdict itself.
app.post('/api/session/decision', (req, res) => {
  const { taps = [], imu = [], trace = null, flags = {} } = req.body || {};
  if (!Array.isArray(taps) || !Array.isArray(imu)) return res.status(400).json({ error: 'taps[] and imu[] required' });

  const parts = risk.buildParts(taps, imu, trace, flags);
  const result = risk.fuseRisk(parts);
  const band = result.score < 30 ? 'low' : result.score < 60 ? 'mid' : 'high';
  const requireChallenge = result.score >= 30 || !!flags.mouseSeen;

  const sessionId = crypto.randomUUID();
  const payload = { sessionId, score: result.score, band, requireChallenge, coverage: result.coverage, iat: Date.now(), exp: Date.now() + DECISION_TTL_MS };
  const signed = signDecision(payload);
  res.json({ ...signed, rows: result.rows });
});

// ---- L4: physical-presence challenge, judged server-side ----
// Client streams the IMU samples captured *during* the shake window; the
// server — not the client's own requestAnimationFrame loop — decides whether
// the peak-energy threshold was met, then issues the final signed authorization.
app.post('/api/session/challenge-result', (req, res) => {
  const { token, signature, imuSamples = [] } = req.body || {};
  if (!token || !signature) return res.status(400).json({ error: 'token and signature required' });
  if (!verifyDecision(token, signature)) return res.status(401).json({ error: 'invalid-or-tampered-token' });
  if (Date.now() > token.exp) return res.status(410).json({ error: 'token-expired' });

  let energy = 0;
  for (const s of imuSamples) if ((s.mag || 0) >= SHAKE_NEED) energy++;
  const authorized = energy >= SHAKE_HITS_REQUIRED;

  const outcome = { sessionId: token.sessionId, authorized, energy, iat: Date.now() };
  res.json(signDecision(outcome));
});

// ---- L3 data collection: persist recordings for the training pipeline ----
app.post('/api/session/export', (req, res) => {
  const record = req.body;
  if (!record || !record.meta) return res.status(400).json({ error: 'record.meta required' });
  const { id } = saveSession(record);
  res.json({ id, stored: true, totalSessions: listSessions().length });
});

app.get('/api/model/weights', (req, res) => {
  res.json({ weights: risk.loadWeights() });
});

const PORT = process.env.PORT || 8787;
if (require.main === module) {
  app.listen(PORT, () => console.log(`PRESENCE server listening on :${PORT}`));
}

module.exports = app;
