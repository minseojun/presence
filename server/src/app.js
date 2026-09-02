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
  const { signed, rows, imuMeta } = computeDecision(taps, imu, trace, flags);
  // imuMeta is descriptive only (median/rstd/tap counts already folded into
  // the signed score above) — exposing it lets the client's history
  // dashboard show real per-signal numbers instead of re-deriving its own
  // shadow copy; it changes nothing about what's trusted for authorization.
  res.json({ ...signed, rows, imuMeta });
});

// ---- L4: physical-presence challenge, judged server-side ----
// Client streams the IMU samples captured *during* the shake window; the
// server — not the client's own requestAnimationFrame loop — decides whether
// the peak-energy threshold was met, then issues the final signed authorization.
app.post('/api/session/challenge-result', (req, res) => {
  const { token, signature, imuSamples = [], baselineSamples = [], tracePts = null } = req.body || {};
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

  // Reported bug (fixed once): a car on a rough road (or a single speed
  // bump) produces one short burst of samples that all clear a magnitude
  // threshold at once — 60Hz sampling turns one ~150ms bump into 9+
  // "qualifying" samples, which used to satisfy SHAKE_HITS_REQUIRED=3
  // outright with zero deliberate shaking. The original fix counted
  // temporally-separated RUNS of qualifying samples (a new run starts once
  // >150ms has passed since the last qualifying sample) instead of raw
  // sample count.
  //
  // That undercounted a real vigorous shake, though (reported separately):
  // during genuine continuous back-and-forth shaking, magnitude often never
  // drops back below the relative threshold between reps — the whole 4s
  // shake reads as ONE uninterrupted qualifying run, so it could only ever
  // register 1 "burst" no matter how many times the phone actually reversed
  // direction. What actually distinguishes repeated shaking from a single
  // jolt is the number of distinct PEAKS (local maxima) in the signal, not
  // whether it dips below threshold between them — so count local maxima at
  // least MIN_PEAK_GAP_MS apart instead. A real hand shake oscillates at
  // roughly 2-6Hz (166-500ms period); a single momentary bump is one ~150ms
  // spike with nowhere near enough span to produce 3 peaks that far apart.
  // MIN_PEAK_GAP_MS=90 keeps generous headroom above a fast 6Hz shake while
  // still requiring genuinely separated peaks, not sensor jitter.
  const MIN_PEAK_GAP_MS = 90;
  const samples = imuSamples.slice().sort((a, b) => (a.t || 0) - (b.t || 0));
  let bursts = 0, lastPeakT = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    const mag = samples[i].mag || 0;
    if (mag < relativeThreshold) continue;
    const prevMag = i > 0 ? (samples[i - 1].mag || 0) : -Infinity;
    const nextMag = i < samples.length - 1 ? (samples[i + 1].mag || 0) : -Infinity;
    const isLocalMax = mag >= prevMag && mag >= nextMag;
    if (isLocalMax && samples[i].t - lastPeakT > MIN_PEAK_GAP_MS) { bursts++; lastPeakT = samples[i].t; }
  }
  const shakeOK = imuSamples.length > 0 && bursts >= SHAKE_HITS_REQUIRED;

  // Optional L4 step 1 (added alongside the shake): the client also streams
  // the points from the "connect start dot to end dot" trace drawn right
  // before shaking. This used to also veto `authorized` on a high pRemote —
  // reverted. Measured against a realistic quick two-dot swipe (short,
  // slightly curved, ordinary touch sampling), analyzeTiming's cv/conc check
  // alone returns pRemote=1.0: real touch/pointer events arrive at a very
  // regular hardware-sampled interval, which is exactly what that heuristic
  // reads as "mechanical". It was only ever validated as a *minor* weighted
  // contributor inside L3's fused score (weight 0.08 alongside imu's 0.5),
  // not as a standalone pass/fail gate — using it as a hard veto here meant
  // almost every real user's honest quick swipe blocked the transfer
  // regardless of how correctly they then shook the device. Kept as
  // descriptive-only (still computed and returned for the dashboard) until
  // it can be recalibrated against real recordings of this specific
  // two-dot gesture, per this project's policy of not gating on
  // physical-sensor heuristics that haven't been validated that way.
  let trajectory = null;
  if (Array.isArray(tracePts) && tracePts.length >= 6) {
    const traj = risk.analyzeTrajectory(tracePts);
    const timing = risk.analyzeTiming(tracePts);
    const pRemote = Math.max(traj.pRemote || 0, timing.pRemote || 0);
    trajectory = { straightness: traj.straightness, cv: timing.insufficient ? null : timing.cv, pRemote };
  }
  const authorized = shakeOK;

  const outcome = { sessionId: token.sessionId, authorized, energy: bursts, threshold: +relativeThreshold.toFixed(2), trajectory, iat: Date.now() };
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
