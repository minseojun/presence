// Adversarial probe against the PRESENCE server: can a scripted attacker (a)
// pass through the browser by synthesizing DeviceMotionEvent/PointerEvent, or
// (b) skip the browser entirely and POST fabricated telemetry straight to the
// API? Run with the server already listening (npm start), then:
//   node test/spoof_test.js [baseUrl]
// Findings are printed and also written to docs/SPOOF_TEST_RESULTS.md.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const CHROME_PATH = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

async function captureDecision(page, action) {
  const respPromise = page.waitForResponse(r => r.url().includes('/api/session/decision'), { timeout: 10000 });
  await action();
  const resp = await respPromise;
  return resp.json();
}

async function scenarioA_realTapsNoMotion(page) {
  // Baseline sanity check: taps happen, IMU stays flat (this is what actual
  // remote-control — scrcpy/AnyDesk driving a phone that sits still on a
  // desk — looks like). Should be flagged high risk.
  await page.evaluate(() => { IMU.length = 0; TAPS.length = 0; });
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => {
      const el = document.getElementById('btnTransfer');
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.x + 10, clientY: r.y + 5, pointerType: 'touch', pressure: 0.6, width: 20, height: 20, bubbles: true }));
    });
    await page.waitForTimeout(150);
  }
  // dispatch the click via page JS (not Playwright's own input pipeline) so
  // no extra real mouse pointerdown gets mixed into the telemetry
  return captureDecision(page, () => page.evaluate(() => document.getElementById('btnTransfer').click()));
}

async function scenarioB_syntheticCorrelatedMotion(page) {
  // A *naive* spoof (constant-magnitude devicemotion fired once per tap) was
  // tried first and, it turns out, backfires by accident: the server's
  // median/MAD baseline is computed from the same handful of IMU samples it
  // is judging, so an attacker who injects only identical values collapses
  // the baseline onto the injected value itself (zero variance -> z-score
  // stays ~0 -> no "impulse" is ever recognized -> imu.p goes UP, not down).
  // That is a fragile, accidental defense, not a real one. This scenario is
  // the version a moderately competent attacker (who profiled the detector,
  // e.g. by reading this exact source file) would actually build: a
  // continuous low-noise "resting" background stream, like a phone sitting
  // still, with a distinct burst injected in the ~280ms window around each
  // tap — i.e. reproducing the *shape* analyzeSession() looks for, not just
  // a constant value.
  await page.evaluate(() => { IMU.length = 0; TAPS.length = 0; });
  const streamBackground = async (ms) => {
    const steps = Math.round(ms / 25);
    for (let i = 0; i < steps; i++) {
      await page.evaluate(() => {
        const jitter = () => (Math.random() - 0.5) * 0.08;
        window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
          acceleration: { x: jitter(), y: jitter(), z: jitter() },
          rotationRate: { alpha: jitter() * 2, beta: jitter() * 2, gamma: jitter() * 2 },
          interval: 16
        }));
      });
      await page.waitForTimeout(25);
    }
  };
  await streamBackground(200); // establish a realistic low-variance resting baseline
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => {
      const el = document.getElementById('btnTransfer');
      const r = el.getBoundingClientRect();
      // burst timed to land inside the server's [-60ms, +220ms] tap window
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
        acceleration: { x: 2.5, y: -1.8, z: 3.1 },
        rotationRate: { alpha: 12, beta: -8, gamma: 5 },
        interval: 16
      }));
      el.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.x + 10, clientY: r.y + 5, pointerType: 'touch', pressure: 0.6, width: 20, height: 20, bubbles: true }));
    });
    await streamBackground(150);
  }
  return captureDecision(page, () => page.evaluate(() => document.getElementById('btnTransfer').click()));
}

async function scenarioC_directApiForgery() {
  // No browser at all: craft a "perfect normal session" telemetry blob by
  // hand and POST it straight to the decision endpoint.
  const now = Date.now();
  const taps = Array.from({ length: 6 }, (_, i) => ({ t: now + i * 300, x: 100 + i, y: 200 }));
  const imu = [];
  for (const tp of taps) for (let k = -3; k <= 8; k++) imu.push({ t: tp.t + k * 20, mag: k >= 0 && k <= 3 ? 3.2 : 0.05, gmag: k >= 0 && k <= 3 ? 8 : 0.1 });
  const r = await fetch(`${BASE}/api/session/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taps, imu, trace: null, flags: {} }) });
  return r.json();
}

async function getSignedHighRiskDecision() {
  // reuse scenario C's shape (a real endpoint call, no browser needed) to get
  // a validly-signed token to attach challenge-result calls to
  const now = Date.now();
  const taps = Array.from({ length: 4 }, (_, i) => ({ t: now + i * 300, x: 100 + i, y: 200 }));
  const imu = taps.flatMap(() => []); // flat/no IMU -> high risk, same as scenario A's premise
  const r = await fetch(`${BASE}/api/session/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taps, imu, trace: null, flags: {} }) });
  return r.json();
}

async function callChallengeResult(decision, imuSamples, baselineSamples) {
  const r = await fetch(`${BASE}/api/session/challenge-result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: decision.payload, signature: decision.signature, imuSamples, baselineSamples }) });
  return r.json();
}

async function scenarioE_vehicleSingleBump(decision) {
  // Real bug report: sitting in a car (a common voice-phishing scenario — the
  // victim is often on the phone WHILE being driven) hitting one speed bump
  // used to authorize the transfer with zero deliberate shaking. At 60Hz
  // sampling a single ~150ms jolt alone contains 6-9 samples clearing the
  // magnitude threshold, which used to satisfy "3 qualifying samples"
  // outright. Fixed by requiring temporally-separated bursts, not raw count.
  const baselineSamples = Array.from({ length: 30 }, (_, i) => ({ t: decision.payload.iat - 2000 + i * 60, mag: 1.8 + Math.random() * 0.6 }));
  const imuSamples = [];
  let t = decision.payload.iat;
  for (let i = 0; i < 40; i++) { imuSamples.push({ t, mag: 1.8 + Math.random() * 0.6 }); t += 60; }
  for (let i = 0; i < 9; i++) { imuSamples.push({ t, mag: 9 + Math.random() }); t += 16; } // one bump, ~150ms
  for (let i = 0; i < 40; i++) { imuSamples.push({ t, mag: 1.8 + Math.random() * 0.6 }); t += 60; }
  return callChallengeResult(decision, imuSamples, baselineSamples);
}

async function scenarioF_bumpyRoadThreeBumps(decision) {
  // Known residual gap, documented rather than hidden: a genuinely rough
  // road producing 3+ well-separated large bumps within the 4s window still
  // authorizes, because each bump is a distinct burst and the fix only
  // collapses samples *within* one burst. Closing this needs a frequency-
  // domain shake signature (2-6Hz oscillation), not implemented here.
  const baselineSamples = Array.from({ length: 30 }, (_, i) => ({ t: decision.payload.iat - 2000 + i * 60, mag: 1.8 + Math.random() * 0.6 }));
  const imuSamples = [];
  let t = decision.payload.iat;
  for (let rep = 0; rep < 3; rep++) {
    for (let i = 0; i < 20; i++) { imuSamples.push({ t, mag: 1.8 + Math.random() * 0.6 }); t += 60; }
    for (let i = 0; i < 9; i++) { imuSamples.push({ t, mag: 9 + Math.random() }); t += 16; }
  }
  return callChallengeResult(decision, imuSamples, baselineSamples);
}

async function scenarioD_forgedChallengeResult(highRiskDecision) {
  // Take a genuinely HIGH-risk signed decision and try to forge it into a
  // pass: flip score/band/requireChallenge to look low-risk while replaying
  // the original (now-mismatched) signature, and throw in fake strong
  // imuSamples for good measure.
  const tampered = { ...highRiskDecision.payload, score: 0, band: 'low', requireChallenge: false };
  const fakeStrongPeaks = Array.from({ length: 10 }, (_, i) => ({ t: tampered.iat + i * 100, mag: 14 + Math.random() }));
  const r = await fetch(`${BASE}/api/session/challenge-result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tampered, signature: highRiskDecision.signature, imuSamples: fakeStrongPeaks }) });
  return { status: r.status, body: await r.json() };
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  // simulate a legitimate user who already granted motion-sensor access
  // (Android Chrome has no permission prompt for this — startSensors() just
  // attaches the listener). Without this the devicemotion listener never
  // exists and scenario B would be trivially "won" for the wrong reason.
  await page.evaluate(() => document.getElementById('btnStart').click());
  await page.waitForTimeout(200);

  const results = {};
  results.A_realTapsNoMotion = await scenarioA_realTapsNoMotion(page);
  results.B_syntheticCorrelatedMotion = await scenarioB_syntheticCorrelatedMotion(page);
  await browser.close();

  results.C_directApiForgery = await scenarioC_directApiForgery();
  results.D_forgedChallengeResult = await scenarioD_forgedChallengeResult(results.A_realTapsNoMotion);

  const challengeDecision = await getSignedHighRiskDecision();
  results.E_vehicleSingleBump = await scenarioE_vehicleSingleBump(challengeDecision);
  results.F_bumpyRoadThreeBumps = await scenarioF_bumpyRoadThreeBumps(challengeDecision);

  const verdictOf = d => `score=${d.payload.score} band=${d.payload.band} requireChallenge=${d.payload.requireChallenge}`;

  const lines = [];
  lines.push('# PRESENCE spoof-test findings (auto-generated, re-run with `npm run test:spoof`)\n');
  lines.push(`Run at ${new Date().toISOString()} against ${BASE}\n`);
  lines.push('## A. Real taps, flat IMU (baseline — simulates scrcpy/AnyDesk driving a phone at rest)');
  lines.push('```\n' + verdictOf(results.A_realTapsNoMotion) + '\n```');
  lines.push(results.A_realTapsNoMotion.payload.band === 'high' ? '**PASS** — correctly flagged high risk.\n' : '**FAIL** — remote-control pattern was NOT flagged high risk.\n');

  lines.push('## B. Browser-level spoof — synthetic DeviceMotionEvent fired in lockstep with synthetic taps');
  lines.push('```\n' + verdictOf(results.B_syntheticCorrelatedMotion) + '\n```');
  const bBeaten = results.B_syntheticCorrelatedMotion.payload.score < results.A_realTapsNoMotion.payload.score - 15;
  lines.push(bBeaten
    ? '**KNOWN GAP CONFIRMED** — hand-scripted `dispatchEvent(DeviceMotionEvent)` measurably lowered the risk score. The touch–IMU signal trusts any event named `devicemotion` regardless of origin; it cannot yet distinguish real hardware from a page script (or a malicious accessibility service) that fires the same event. Only a native/OS-level attestation (e.g. Play Integrity API) closes this — flagged in docs/LIMITATIONS.md, not solved by this codebase.\n'
    : '**Held** — the fusion of traj/timing/props signals kept the score high even with faked IMU peaks alone; single-signal spoofing was insufficient in this run.\n');

  lines.push('## C. Direct API forgery — bypassing the browser, POSTing hand-crafted "perfect normal session" telemetry');
  lines.push('```\n' + verdictOf(results.C_directApiForgery) + '\n```');
  lines.push('This is *expected* to look low-risk — telemetry authenticity (that it came from a real device at all) is a separate, unsolved problem from scoring-given-telemetry. It is why L4 (the shake challenge) exists as the enforcement point, not the L3 score alone: even a forged low-risk score cannot self-authorize a transfer, since `requireChallenge` still routes through a server-graded physical challenge before `challenge-result` returns `authorized`.\n');

  lines.push('## D. Forged challenge-result — replaying a valid signature over a tampered token payload');
  lines.push('```\n' + JSON.stringify(results.D_forgedChallengeResult) + '\n```');
  lines.push(results.D_forgedChallengeResult.status === 401
    ? '**PASS** — HMAC signature check rejected the tampered payload; token integrity holds.\n'
    : '**FAIL** — tampered token was accepted; signing is broken.\n');

  lines.push('## E. Vehicle single-bump — one ~150ms speed-bump burst during the shake challenge (regression test for a real bug report)');
  lines.push('```\n' + JSON.stringify(results.E_vehicleSingleBump) + '\n```');
  lines.push(results.E_vehicleSingleBump.payload.authorized === false
    ? '**PASS** — a single momentary jolt (e.g. a car hitting one speed bump while the victim is being socially engineered mid-drive) is correctly rejected. Fixed by requiring temporally-separated *bursts* of qualifying samples (gap > 150ms starts a new burst) instead of a raw qualifying-sample count, which a single ~150ms jolt could satisfy outright at 60Hz sampling.\n'
    : '**FAIL (regression)** — a single vehicle bump alone authorized the transfer again.\n');

  lines.push('## F. Bumpy road, three separated bumps — known residual gap (documented, not fixed)');
  lines.push('```\n' + JSON.stringify(results.F_bumpyRoadThreeBumps) + '\n```');
  lines.push(results.F_bumpyRoadThreeBumps.payload.authorized === true
    ? '**KNOWN GAP** — a genuinely rough road producing 3+ well-separated large bumps within the challenge window still authorizes, since each bump is its own burst and burst-counting alone cannot tell "3 deliberate shakes" from "3 distinct road bumps". Closing this fully needs frequency-domain shake-signature analysis (a real hand shake oscillates ~2-6Hz with alternating direction; a bump is a single-direction impulse) — not implemented here for lack of real calibration data to validate against, consistent with this project\'s policy of not guessing new physical-sensor constants. Tracked in docs/LIMITATIONS.md.\n'
    : '**Improved beyond expectation** — this run rejected the multi-bump pattern too (not guaranteed by the current fix; treat as incidental, not relied upon).\n');

  const out = lines.join('\n');
  console.log(out);
  fs.writeFileSync(path.join(__dirname, '..', '..', 'docs', 'SPOOF_TEST_RESULTS.md'), out);
})().catch(e => { console.error('spoof test crashed:', e); process.exit(1); });
