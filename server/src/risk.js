// Server-authoritative L3 (session integrity) feature extraction + fusion.
// Ported from the original client-only prototype (index.html) — the math is
// unchanged, but it now runs where a client script cannot patch the result.
const fs = require('fs');
const path = require('path');

const WEIGHTS_PATH = path.join(__dirname, '..', 'data', 'model', 'weights.json');
const DEFAULT_WEIGHTS = { imu: 0.5, traj: 0.3, props: 0.12, timing: 0.08 };

function loadWeights() {
  try {
    const raw = JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8'));
    if (raw && raw.weights) return raw.weights;
  } catch (_) { /* fall back to defaults until scripts/train_l3_model.js writes a real file */ }
  return DEFAULT_WEIGHTS;
}

const median = a => { const b = [...a].sort((x, y) => x - y), n = b.length; return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : 0; };
const mad = (a, m) => median(a.map(x => Math.abs(x - m)));
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const stdev = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

const CFG = { zTh: 3.5, minPeakAbs: 0.35, gZ: 4.0, gMinAbs: 6.0 };

function analyzeSession(taps, imu, o = {}) {
  const preMs = 60, postMs = 220, zTh = o.zTh ?? CFG.zTh, minPeakAbs = o.minPeakAbs ?? CFG.minPeakAbs;
  const A = imu.map(s => s.mag), base = median(A), rstd = Math.max(1.4826 * mad(A, base), 1e-6);
  const G = imu.map(s => s.gmag || 0), Gb = median(G), Grstd = Math.max(1.4826 * mad(G, Gb), 1e-6);
  let hit = 0;
  const perTap = taps.map(tp => {
    const w = imu.filter(s => s.t >= tp.t - preMs && s.t <= tp.t + postMs);
    let ap = 0, gp = 0;
    for (const s of w) { if (s.mag > ap) ap = s.mag; if ((s.gmag || 0) > gp) gp = s.gmag || 0; }
    const az = (ap - base) / rstd, aHit = az >= zTh && (ap - base) >= minPeakAbs;
    const gz = (gp - Gb) / Grstd, gHit = gz >= CFG.gZ && (gp - Gb) >= CFG.gMinAbs;
    const present = aHit || gHit;
    if (present) hit++;
    return { t: tp.t, peak: +ap.toFixed(3), z: +az.toFixed(2), present };
  });
  return {
    base: +base.toFixed(3), rstd: +rstd.toFixed(4), tapCount: taps.length, impulseHits: hit,
    impulseRatio: taps.length ? +(hit / taps.length).toFixed(3) : 0, perTap
  };
}

function analyzeTrajectory(pts) {
  if (!pts || pts.length < 6) return { n: pts ? pts.length : 0, insufficient: true, pRemote: 0 };
  let path_ = 0; for (let i = 1; i < pts.length; i++) path_ += dist(pts[i - 1], pts[i]);
  const chord = dist(pts[0], pts[pts.length - 1]) || 1e-6, straightness = path_ / chord;
  const sp = []; for (let i = 1; i < pts.length; i++) { const dt = (pts[i].t - pts[i - 1].t) || 1; sp.push(dist(pts[i - 1], pts[i]) / dt); }
  let sub = 0, ms = mean(sp); for (let i = 1; i < sp.length - 1; i++) if (sp[i] > sp[i - 1] && sp[i] > sp[i + 1] && sp[i] > ms * 0.6) sub++;
  const frac = pts.filter(p => (p.x % 1) || (p.y % 1)).length / pts.length;
  let p = 0;
  p += straightness < 1.02 ? 0.45 : straightness < 1.05 ? 0.2 : 0;
  p += sub <= 1 ? 0.3 : sub <= 3 ? 0.12 : 0;
  p += frac < 0.1 ? 0.25 : frac < 0.4 ? 0.1 : 0;
  return { n: pts.length, straightness: +straightness.toFixed(3), submovements: sub, subpixelFrac: +frac.toFixed(2), pRemote: +Math.min(1, p).toFixed(2) };
}

function analyzeTiming(pts) {
  if (!pts || pts.length < 8) return { n: pts ? pts.length : 0, insufficient: true, pRemote: 0 };
  const iv = []; for (let i = 1; i < pts.length; i++) iv.push(pts[i].t - pts[i - 1].t);
  const md = median(iv), cv = stdev(iv) / (mean(iv) || 1), rateHz = 1000 / (mean(iv) || 1);
  const conc = iv.filter(v => Math.abs(v - md) <= 1).length / iv.length;
  let p = 0;
  if (cv < 0.08) p += 0.5; else if (cv < 0.13) p += 0.2;
  if (conc > 0.9) p += 0.3; else if (conc > 0.8) p += 0.12;
  if (rateHz < 70) p += 0.2;
  return { n: pts.length, rateHz: +rateHz.toFixed(0), cv: +cv.toFixed(3), conc: +conc.toFixed(2), pRemote: +Math.min(1, p).toFixed(2) };
}

const LBL = { imu: '터치–IMU 임펄스', traj: '궤적 기하', props: '포인터 속성', timing: '이벤트 타이밍' };

function propsSignal(f) {
  let p = 0; if (f.mouseSeen) p += 0.7; if (f.noTouchDetail) p += 0.25; if (f.quantized) p += 0.15;
  return { p: +Math.min(1, p).toFixed(2), ok: true };
}

function fuseRisk(parts, weights = loadWeights()) {
  let num = 0, den = 0; const rows = [];
  for (const k of ['imu', 'traj', 'props', 'timing']) {
    const pt = parts[k], active = pt && pt.ok, w = weights[k] ?? DEFAULT_WEIGHTS[k];
    if (active) { num += w * pt.p; den += w; }
    rows.push({ k, label: LBL[k], p: pt ? pt.p : null, w, active });
  }
  return { score: den ? Math.round(100 * num / den) : 0, rows, coverage: +den.toFixed(2) };
}

function buildParts(taps, imu, trace, flags) {
  const a = analyzeSession(taps, imu);
  const parts = {};
  parts.imu = taps.length >= 2 ? { p: +(1 - a.impulseRatio).toFixed(2), ok: true, meta: a } : { p: 0, ok: false, meta: a };
  parts.traj = (trace && trace.traj && !trace.traj.insufficient) ? { p: trace.traj.pRemote, ok: true } : { p: 0, ok: false };
  parts.timing = (trace && trace.timing && !trace.timing.insufficient) ? { p: trace.timing.pRemote, ok: true } : { p: 0, ok: false };
  parts.props = propsSignal(flags || {});
  return parts;
}

module.exports = { median, mad, mean, stdev, analyzeSession, analyzeTrajectory, analyzeTiming, fuseRisk, buildParts, loadWeights, DEFAULT_WEIGHTS };
