// Fits L3 fusion weights from real collected sessions (server/data/sessions/,
// populated by the 수집 tab's "JSON 내보내기" -> server upload) and reports
// per-layer ablation + FPR at TPR=95%. This is REAL, runnable code — what it
// cannot do is manufacture the human data itself. Run it after collecting
// normal-vs-remote recordings from real participants:
//   node scripts/train_l3_model.js
// To sanity-check the pipeline mechanics before you have real recordings:
//   node scripts/train_l3_model.js --synthetic
// (synthetic mode writes clearly-labeled fake data, trains on it, and prints
// a banner — it must never be mistaken for a real evaluation result.)
const fs = require('fs');
const path = require('path');
const risk = require('../server/src/risk');

const SESSIONS_DIR = path.join(__dirname, '..', 'server', 'data', 'sessions');
const WEIGHTS_PATH = path.join(__dirname, '..', 'server', 'data', 'model', 'weights.json');
const REPORT_PATH = path.join(__dirname, '..', 'docs', 'L3_TRAINING_REPORT.md');

function loadRecords() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
}

function synthesize(n = 60) {
  // NOT a substitute for real human/scrcpy recordings — only exercises the
  // pipeline's plumbing (parsing, feature extraction, fitting, reporting).
  const recs = [];
  for (let i = 0; i < n; i++) {
    const isRemote = i % 2 === 0;
    const t0 = 0;
    const taps = Array.from({ length: 6 }, (_, k) => ({ t: t0 + k * 300 + (Math.random() * 20 - 10), x: 100, y: 200 }));
    const imu = [];
    for (const tp of taps) {
      for (let k = -6; k <= 12; k++) {
        const bg = (Math.random() - 0.5) * 0.1;
        const burst = (!isRemote && k >= 0 && k <= 3) ? 3 + Math.random() : 0;
        imu.push({ t: tp.t + k * 20, mag: Math.abs(bg + burst) + 0.02, gmag: burst ? 8 + Math.random() * 2 : Math.abs(bg) });
      }
    }
    const trace = [];
    const n2 = 20;
    for (let k = 0; k < n2; k++) {
      const f = k / (n2 - 1);
      const curve = isRemote ? 0 : Math.sin(f * Math.PI) * 8; // humans arc, remote cursors go straight
      trace.push({ t: k * (isRemote ? 16 : 30 + Math.random() * 15), x: 20 + f * 200 + curve + (isRemote ? 0 : (Math.random() - 0.5) * 2), y: 20 + f * 150 - curve });
    }
    recs.push({ meta: { label: isRemote ? 'remote' : 'normal', participant: `synthetic_${i}` }, taps, imu, trace });
  }
  return recs;
}

function extractFeatureVector(rec) {
  const taps = rec.taps || [];
  const imu = rec.imu || [];
  const trace = rec.trace || [];
  const a = risk.analyzeSession(taps, imu);
  const traj = risk.analyzeTrajectory(trace);
  const timing = risk.analyzeTiming(trace);
  return {
    label: rec.meta.label === 'remote' ? 1 : 0,
    imu_p: taps.length >= 2 ? 1 - a.impulseRatio : null,
    traj_p: traj.insufficient ? null : traj.pRemote,
    timing_p: timing.insufficient ? null : timing.pRemote,
    props_p: 0, // pointer-property flags aren't in the exported schema; treated as unavailable offline
  };
}

// --- tiny logistic regression (batch gradient descent), no deps ---
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function fitLogistic(X, y, { lr = 0.3, epochs = 2000, l2 = 0.01 } = {}) {
  const d = X[0].length;
  let w = new Array(d).fill(0), b = 0;
  const n = X.length;
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      const z = X[i].reduce((s, x, j) => s + x * w[j], b);
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  return { w, b };
}

function auc(scores, labels) {
  const pairs = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
  const nPos = labels.filter(l => l === 1).length, nNeg = labels.length - nPos;
  if (!nPos || !nNeg) return null;
  let rankSum = 0;
  pairs.forEach(([, l], idx) => { if (l === 1) rankSum += idx + 1; });
  return (rankSum - nPos * (nPos + 1) / 2) / (nPos * nNeg);
}

function fprAtTpr(scores, labels, targetTpr = 0.95) {
  const thresholds = [...new Set(scores)].sort((a, b) => a - b);
  const pos = labels.reduce((s, l) => s + l, 0), neg = labels.length - pos;
  if (!pos || !neg) return null;
  let best = null;
  for (const th of thresholds) {
    let tp = 0, fp = 0;
    for (let i = 0; i < scores.length; i++) {
      const pred = scores[i] >= th ? 1 : 0;
      if (pred === 1 && labels[i] === 1) tp++;
      if (pred === 1 && labels[i] === 0) fp++;
    }
    const tpr = tp / pos, fpr = fp / neg;
    if (tpr >= targetTpr) { if (best === null || fpr < best.fpr) best = { fpr, threshold: th, tpr }; }
  }
  return best;
}

function fuseWith(weights, feats) {
  let num = 0, den = 0;
  for (const k of ['imu', 'traj', 'timing', 'props']) {
    const key = `${k}_p`, w = weights[k];
    if (feats[key] != null) { num += w * feats[key]; den += w; }
  }
  return den ? num / den : 0;
}

function run() {
  const synthetic = process.argv.includes('--synthetic');
  const records = synthetic ? synthesize() : loadRecords();
  const lines = [];
  lines.push(`# PRESENCE L3 training report${synthetic ? ' — ⚠ SYNTHETIC DATA (pipeline smoke test, NOT a real result)' : ''}`);
  lines.push(`\nGenerated ${new Date().toISOString()} from ${records.length} session(s) in \`${synthetic ? '(synthetic, not persisted)' : path.relative(process.cwd(), SESSIONS_DIR)}\`.\n`);

  if (!synthetic && records.length < 10) {
    lines.push(`**Insufficient data (${records.length} sessions).** Existing default weights in \`server/data/model/weights.json\` were left unchanged. Collect at least ~10 normal + ~10 remote sessions via the 수집 tab (or \`node scripts/train_l3_model.js --synthetic\` to sanity-check the pipeline itself) before training for real.\n`);
    fs.writeFileSync(REPORT_PATH, lines.join('\n'));
    console.log(lines.join('\n'));
    return;
  }

  const feats = records.map(extractFeatureVector);
  const nRemote = feats.filter(f => f.label === 1).length, nNormal = feats.length - nRemote;
  lines.push(`Label balance: ${nNormal} normal, ${nRemote} remote.\n`);
  if (nRemote === 0 || nNormal === 0) {
    lines.push('**Both classes are required.** Aborting — weights unchanged.\n');
    fs.writeFileSync(REPORT_PATH, lines.join('\n'));
    console.log(lines.join('\n'));
    return;
  }

  // fit fusion weights: logistic regression over the four p-values (missing -> 0,
  // matching the server's "inactive signal contributes nothing" semantics)
  const keys = ['imu_p', 'traj_p', 'timing_p', 'props_p'];
  const X = feats.map(f => keys.map(k => f[k] ?? 0));
  const y = feats.map(f => f.label);
  const { w } = fitLogistic(X, y);
  const wPos = w.map(v => Math.max(0, v));
  const wSum = wPos.reduce((s, v) => s + v, 0) || 1;
  const weights = { imu: +(wPos[0] / wSum).toFixed(3), traj: +(wPos[1] / wSum).toFixed(3), timing: +(wPos[2] / wSum).toFixed(3), props: +(wPos[3] / wSum).toFixed(3) };

  // ablation: cumulative layer sets, uniform weight within the active subset
  const ablationSets = [['imu'], ['imu', 'traj'], ['imu', 'traj', 'timing'], ['imu', 'traj', 'timing', 'props']];
  lines.push('## Ablation (FPR at TPR=95%, higher fused score = more suspicious)\n');
  lines.push('| layers | AUC | FPR@TPR95 | threshold |');
  lines.push('|---|---|---|---|');
  for (const set of ablationSets) {
    const uniform = {}; for (const k of ['imu', 'traj', 'timing', 'props']) uniform[k] = set.includes(k) ? 1 : 0;
    const scores = feats.map(f => fuseWith(uniform, f));
    const a = auc(scores, y);
    const f95 = fprAtTpr(scores, y);
    lines.push(`| ${set.join('+')} | ${a != null ? a.toFixed(3) : 'n/a'} | ${f95 ? (f95.fpr * 100).toFixed(1) + '%' : 'n/a'} | ${f95 ? f95.threshold.toFixed(2) : 'n/a'} |`);
  }

  const finalScores = feats.map(f => fuseWith(weights, f));
  const finalAuc = auc(finalScores, y);
  const finalF95 = fprAtTpr(finalScores, y);
  lines.push(`\n## Fitted fusion weights\n\`\`\`json\n${JSON.stringify(weights, null, 2)}\n\`\`\`\n`);
  lines.push(`Fitted-weight fusion: AUC=${finalAuc != null ? finalAuc.toFixed(3) : 'n/a'}, FPR@TPR95=${finalF95 ? (finalF95.fpr * 100).toFixed(1) + '%' : 'n/a'}.\n`);

  if (!synthetic) {
    fs.mkdirSync(path.dirname(WEIGHTS_PATH), { recursive: true });
    fs.writeFileSync(WEIGHTS_PATH, JSON.stringify({ trainedAt: new Date().toISOString(), nSessions: records.length, weights }, null, 2));
    lines.push(`Weights written to \`${path.relative(process.cwd(), WEIGHTS_PATH)}\` — the server picks these up on next request (no restart needed).\n`);
  } else {
    lines.push('Synthetic run — weights file NOT overwritten.\n');
  }

  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(lines.join('\n'));
}

run();
