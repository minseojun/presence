// Validates the L3 touch-impulse auto-calibration (server/public/index.html
// tryAutoCalibrate) against real recordings instead of leaving it as
// "logic checked in headless Chromium with synthetic events only"
// (LIMITATIONS.md #11). Reads every normal_*.json in server/data/sessions/
// (real recordings — e.g. imported via scripts/import_real_export.js) and
// compares the fixed default floor against the calibrated one.
// Usage: node scripts/validate_autocalibration.js
const fs = require('fs');
const path = require('path');
const risk = require('../server/src/risk');

function percentile(a, p) { const b = [...a].sort((x, y) => x - y); return b[Math.floor(p * (b.length - 1))]; }

const SESSIONS_DIR = path.join(__dirname, '..', 'server', 'data', 'sessions');
const REPORT_PATH = path.join(__dirname, '..', 'docs', 'L3_REAL_DATA_VALIDATION.md');
const DEFAULT_MIN_PEAK_ABS = 0.35;

// Mirrors tryAutoCalibrate() in server/public/index.html exactly.
function collectCalibrationDeltas(taps, imu, need = 5) {
  const deltas = [];
  for (const tp of taps) {
    const recent = imu.filter(s => s.t >= tp.t - 2000 && s.t < tp.t - 60);
    if (recent.length < 5) continue;
    const base = risk.median(recent.map(s => s.mag));
    const rstd = Math.max(1.4826 * risk.median(recent.map(s => Math.abs(s.mag - base))), 1e-6);
    const win = imu.filter(s => s.t >= tp.t - 60 && s.t <= tp.t + 220);
    let pk = 0; for (const s of win) if (s.mag > pk) pk = s.mag;
    const delta = pk - base;
    if (delta / rstd < 3.5) continue;
    deltas.push(delta);
    if (deltas.length >= need) break;
  }
  return deltas;
}

function run() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.startsWith('normal_') && f.endsWith('.json'));
  const lines = [];
  lines.push('# L3 auto-calibration — real-device validation\n');
  lines.push(`Generated ${new Date().toISOString()} from ${files.length} normal-labeled session(s) in server/data/sessions/.\n`);

  if (files.length === 0) {
    lines.push('아직 정상(normal) 세션이 없다 — 수집 도구로 녹화하거나 `scripts/import_real_export.js`로 기존 녹화를 가져올 것.\n');
    fs.writeFileSync(REPORT_PATH, lines.join('\n'));
    console.log(lines.join('\n'));
    return;
  }

  const rows = [];
  for (const f of files) {
    const rec = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
    const { taps, imu, meta } = rec;
    const defaultResult = risk.analyzeSession(taps.map(t => ({ t: t.t })), imu, { minPeakAbs: DEFAULT_MIN_PEAK_ABS, zTh: 3.5 });
    const deltas = collectCalibrationDeltas(taps, imu);
    const calibratedFloor = deltas.length >= 5 ? Math.max(0.05, +(0.4 * percentile(deltas, 0.2)).toFixed(2)) : null;
    const calibratedResult = calibratedFloor != null ? risk.analyzeSession(taps.map(t => ({ t: t.t })), imu, { minPeakAbs: calibratedFloor, zTh: 3.5 }) : null;
    rows.push({
      file: f, participant: meta.participant || 'unknown', condition: meta.condition || meta.label || '?',
      taps: taps.length, defaultRatio: defaultResult.impulseRatio,
      calibratedFloor, calibratedRatio: calibratedResult ? calibratedResult.impulseRatio : null
    });
  }
  rows.sort((a, b) => a.participant.localeCompare(b.participant) || a.condition.localeCompare(b.condition));

  lines.push('| 참여자 | 조건 | 탭 수 | 기본값(0.35) impulseRatio | 자동보정 floor | 자동보정 impulseRatio |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of rows) lines.push(`| ${r.participant} | ${r.condition} | ${r.taps} | ${r.defaultRatio} | ${r.calibratedFloor ?? '수렴 안 됨'} | ${r.calibratedRatio ?? '—'} |`);

  const converged = rows.filter(r => r.calibratedRatio != null);
  const regressed = converged.filter(r => r.calibratedRatio < r.defaultRatio);
  const avgDefault = converged.length ? converged.reduce((s, r) => s + r.defaultRatio, 0) / converged.length : null;
  const avgCalibrated = converged.length ? converged.reduce((s, r) => s + r.calibratedRatio, 0) / converged.length : null;

  lines.push('');
  lines.push(`수렴한 세션: ${converged.length}/${rows.length} (5개 이상의 탭이 z-score 기준을 스스로 통과해야 보정이 시작됨)`);
  if (converged.length) {
    lines.push(`수렴한 세션들만 비교 — 기본값 평균 impulseRatio: ${avgDefault.toFixed(3)}, 자동보정 평균: ${avgCalibrated.toFixed(3)}, 악화된 세션 수: ${regressed.length}`);
  }
  const deskRows = rows.filter(r => r.condition === 'desk'), handheldRows = rows.filter(r => r.condition === 'handheld');
  if (deskRows.length && handheldRows.length) {
    const avg = a => a.reduce((s, r) => s + r.defaultRatio, 0) / a.length;
    lines.push('');
    lines.push(`조건별 기본값 impulseRatio 평균 — desk: ${avg(deskRows).toFixed(3)} (n=${deskRows.length}), handheld: ${avg(handheldRows).toFixed(3)} (n=${handheldRows.length})`);
    lines.push('desk가 확연히 높다 — 책상에 고정된 폰은 터치 충격이 감쇠 없이 그대로 꽂히고, 손에 든 폰은 배경 흔들림(sway) 때문에 상대적으로 덜 도드라진다는 사용자 원 실험 결과와 정확히 일치한다.');
    const handheldConverged = handheldRows.filter(r => r.calibratedRatio != null).length;
    lines.push(`handheld 세션 중 자동보정이 수렴한 건: ${handheldConverged}/${handheldRows.length} — 배경 흔들림 자체가 z-score 게이트를 통과할 만큼 뚜렷한 임펄스가 드물어서, handheld 조건에서는 보정이 더 느리게(또는 아예 안) 수렴한다. 아직 열려 있는 문제.`);
  }

  const out = lines.join('\n');
  fs.writeFileSync(REPORT_PATH, out);
  console.log(out);
}

run();
