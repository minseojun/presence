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
// Absolute m/s^2 thresholds (13, then 7) were both guesses tuned against one
// device and broke on the next one (Android -> iPhone). Devicemotion scale
// varies by OS/hardware, so judge the shake RELATIVE to that same session's
// own resting baseline instead of a fixed constant — this is device-agnostic
// by construction. A real shake is a handful of samples several multiples
// above the ambient noise floor; a still phone (or a phone that was never
// picked up) never produces that gap regardless of its absolute scale.
const SHAKE_HITS_REQUIRED = 3;

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
  const { token, signature, imuSamples = [], baselineSamples = [] } = req.body || {};
  if (!token || !signature) return res.status(400).json({ error: 'token and signature required' });
  if (!verifyDecision(token, signature)) return res.status(401).json({ error: 'invalid-or-tampered-token' });
  if (Date.now() > token.exp) return res.status(410).json({ error: 'token-expired' });

  // The baseline MUST come from before the challenge window (client sends the
  // IMU tail captured right before the shake prompt opened), never from the
  // same samples being judged — otherwise a vigorous, sustained shake that
  // dominates the judged window drags its own "ambient" median up and
  // silently raises the bar against itself.
  const baseSource = baselineSamples.length ? baselineSamples.map(s => s.mag || 0) : imuSamples.map(s => s.mag || 0);
  const base = risk.median(baseSource);
  // needs a real spike: 4x the ambient floor, with a minimum absolute jump
  // so a near-zero baseline (phone dead still) doesn't make everything count
  const relativeThreshold = Math.max(base * 4, base + 3);

  // Reported bug: a car on a rough road (or a single speed bump) produces one
  // short burst of samples that all clear a magnitude threshold at once —
  // 60Hz sampling turns one ~150ms bump into 9+ "qualifying" samples, which
  // used to satisfy SHAKE_HITS_REQUIRED=3 outright with zero deliberate
  // shaking. A real human shake is repeated back-and-forth motion spread
  // over the window, not one instant — so count temporally-separated BURSTS
  // (samples >=150ms apart start a new burst) instead of raw sample count.
  // This is exactly the scenario the reporter hit: sitting in a moving car
  // while being socially engineered into a transfer is a common real
  // voice-phishing pattern, so ambient vehicle vibration defeating the
  // physical-presence check is a real bypass, not just a UX nuisance.
  const BURST_GAP_MS = 150;
  const qualifyingTimes = imuSamples.filter(s => (s.mag || 0) >= relativeThreshold).map(s => s.t).sort((a, b) => a - b);
  let bursts = 0, lastT = -Infinity;
  for (const t of qualifyingTimes) { if (t - lastT > BURST_GAP_MS) bursts++; lastT = t; }
  const authorized = imuSamples.length > 0 && bursts >= SHAKE_HITS_REQUIRED;

  const outcome = { sessionId: token.sessionId, authorized, energy: bursts, threshold: +relativeThreshold.toFixed(2), iat: Date.now() };
  res.json(signDecision(outcome));
});

// ---- L3 data collection: persist recordings for the training pipeline ----
// Serverless deployments (Vercel) ship a read-only filesystem — there's
// nowhere durable to write here. Real data collection is a `npm start`-on-
// your-own-machine workflow (see README); the public deployment just says so
// instead of pretending to save and silently losing the recording.
app.post('/api/session/export', (req, res) => {
  if (process.env.VERCEL) {
    return res.status(501).json({ error: 'not-supported-on-this-deployment', message: '이 배포 환경은 저장소가 없어 세션을 저장할 수 없습니다. 로컬에서 npm start로 실행해 수집하세요 (파일은 이미 다운로드됐습니다).' });
  }
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
