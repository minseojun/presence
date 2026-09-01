const express = require('express');
const path = require('path');
const crypto = require('crypto');
const risk = require('./risk');
const { analyzeMessageWithClaude } = require('./l0');
const { scoreDomain } = require('./l1');
const { analyzeLandingPage } = require('./l2');
const { signDecision, verifyDecision } = require('./sign');
const store = require('./store');
const { saveSession, listSessions, getSession } = store;

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/demo', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'demo.html')));

const DECISION_TTL_MS = 60_000;
// Absolute m/s^2 thresholds (13, then 7) were both guesses tuned against one
// device and broke on the next one (Android -> iPhone). Devicemotion scale
// varies by OS/hardware, so judge the shake RELATIVE to that same session's
// own resting baseline instead of a fixed constant — this is device-agnostic
// by construction. A real shake is a handful of samples several multiples
// above the ambient noise floor; a still phone (or a phone that was never
// picked up) never produces that gap regardless of its absolute scale.
const SHAKE_HITS_REQUIRED = 3;

// ---- L0: AI-based message/call-script triage (real LLM call, not a heuristic) ----
app.post('/api/l0/analyze-message', async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(501).json({ error: 'not-configured', message: 'AI 문자 분석을 쓰려면 서버에 ANTHROPIC_API_KEY 환경변수가 필요합니다 (README 참고). 나머지 기능(L1~L4)은 이 설정 없이도 정상 동작합니다.' });
  }
  try {
    res.json(await analyzeMessageWithClaude(text, apiKey));
  } catch (e) {
    res.status(502).json({ error: 'ai-request-failed', message: e.message });
  }
});

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
function computeDecision(taps, imu, trace, flags) {
  const parts = risk.buildParts(taps, imu, trace, flags);
  const result = risk.fuseRisk(parts);
  const band = result.score < 30 ? 'low' : result.score < 60 ? 'mid' : 'high';
  const requireChallenge = result.score >= 30 || !!flags.mouseSeen;

  const sessionId = crypto.randomUUID();
  const payload = { sessionId, score: result.score, band, requireChallenge, coverage: result.coverage, iat: Date.now(), exp: Date.now() + DECISION_TTL_MS };
  return { signed: signDecision(payload), rows: result.rows, imuMeta: parts.imu.meta };
}

app.post('/api/session/decision', (req, res) => {
  const { taps = [], imu = [], trace = null, flags = {} } = req.body || {};
  if (!Array.isArray(taps) || !Array.isArray(imu)) return res.status(400).json({ error: 'taps[] and imu[] required' });
  const { signed, rows } = computeDecision(taps, imu, trace, flags);
  res.json({ ...signed, rows });
});

// ---- Judge/demo dashboard: identical decision math, extra debug detail ----
// Same computeDecision() as production — the token it signs is accepted by
// the real /api/session/challenge-result below unchanged. The only addition
// is `debug.imu`, the real per-tap impulse trace from analyzeSession(), so
// server/public/demo.html can chart the actual signal instead of a fabricated
// number. Kept as a separate route so the production decision endpoint's
// response shape never changes.
app.post('/api/demo/decision', (req, res) => {
  const { taps = [], imu = [], trace = null, flags = {} } = req.body || {};
  if (!Array.isArray(taps) || !Array.isArray(imu)) return res.status(400).json({ error: 'taps[] and imu[] required' });
  const { signed, rows, imuMeta } = computeDecision(taps, imu, trace, flags);
  res.json({ ...signed, rows, debug: { imu: imuMeta || null } });
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
// Local dev writes straight to disk. Serverless (Vercel) ships a read-only
// filesystem, so store.js switches to Vercel Blob there IF a Blob store is
// connected to the project (BLOB_READ_WRITE_TOKEN gets auto-injected when
// you do — see README). If Vercel + no Blob store, say so clearly instead
// of pretending to save and silently losing the recording.
app.post('/api/session/export', async (req, res) => {
  const record = req.body;
  if (!record || !record.meta) return res.status(400).json({ error: 'record.meta required' });
  if (process.env.VERCEL && !store.useBlob) {
    return res.status(501).json({ error: 'not-configured', message: '이 배포 환경엔 Blob 저장소가 연결되어 있지 않아 세션을 저장할 수 없습니다. Vercel 프로젝트의 Storage 탭에서 Blob 저장소를 만들어 연결하세요 (README 참고). 파일은 이미 다운로드됐습니다.' });
  }
  try {
    const { id } = await saveSession(record);
    res.json({ id, stored: true, totalSessions: (await listSessions()).length });
  } catch (e) {
    res.status(502).json({ error: 'save-failed', message: '세션 저장에 실패했습니다: ' + e.message + ' (파일은 이미 다운로드됐습니다).' });
  }
});

// ---- L3 data collection: browse + compare stored sessions in the browser ----
// Lets a non-technical user compare two already-uploaded recordings (e.g. one
// "정상", one "원격 조작") straight from the deployed page — no local clone,
// no CLI, no token handling. Read-only; reuses the same storage backend as
// the export endpoint above (local fs or Vercel Blob).
app.get('/api/session/list', async (req, res) => {
  try {
    res.json({ sessions: await listSessions() });
  } catch (e) {
    res.status(502).json({ error: 'list-failed', message: e.message });
  }
});
app.get('/api/session/:id', async (req, res) => {
  try {
    const record = await getSession(req.params.id);
    if (!record) return res.status(404).json({ error: 'not-found' });
    res.json(record);
  } catch (e) {
    res.status(502).json({ error: 'read-failed', message: e.message });
  }
});

app.get('/api/model/weights', (req, res) => {
  res.json({ weights: risk.loadWeights() });
});

const PORT = process.env.PORT || 8787;
if (require.main === module) {
  app.listen(PORT, () => console.log(`PRESENCE server listening on :${PORT}`));
}

module.exports = app;
