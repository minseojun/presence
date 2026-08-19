// Converts a "remoteguard.export.v1" recording (real iPhone device.motion +
// touch events, collected by the user before this project's own 수집 tool
// existed) into this codebase's session JSON format and drops one file per
// session into server/data/sessions/, so scripts/train_l3_model.js can use
// them like any other collected recording.
//
// Usage: node scripts/import_real_export.js <export.json>
const fs = require('fs');
const path = require('path');
const risk = require('../server/src/risk');

const inputPath = process.argv[2];
if (!inputPath) { console.error('usage: node scripts/import_real_export.js <export.json>'); process.exit(1); }

const SESSIONS_DIR = path.join(__dirname, '..', 'server', 'data', 'sessions');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
if (raw.schema !== 'remoteguard.export.v1') console.warn(`warning: unexpected schema "${raw.schema}", trying anyway`);

let written = 0;
for (const s of raw.sessions) {
  const imu = s.events.filter(e => e.type === 'motion').map(e => ({
    t: e.t, ax: e.ax, ay: e.ay, az: e.az,
    mag: Math.hypot(e.ax || 0, e.ay || 0, e.az || 0),
    gmag: Math.hypot(e.gx || 0, e.gy || 0, e.gz || 0)
  }));
  // Only real touch events count as taps — iOS fires synthetic mousemove/
  // mousedown "compatibility" events right after every touch, and counting
  // those would trip our own mouseSeen heuristic on genuinely normal touch
  // sessions (it's built to flag exactly that pattern as suspicious).
  const taps = s.events.filter(e => e.type === 'touchstart').map(e => ({
    t: e.t, x: e.x, y: e.y, ptype: 'touch', quant: Number.isInteger(e.x) && Number.isInteger(e.y)
  }));
  const trace = []; // this export has no drag-path capture; trajectory/timing signal stays inactive, same as any session without a drag

  const label = 'normal'; // both desk and handheld are label:0 (human-operated) in the source export — no remote condition in this dataset yet
  const participant = s.subject_id || 'unknown';
  const condition = s.condition || 'unknown';

  const features = {
    imu: risk.analyzeSession(taps.map(t => ({ t: t.t })), imu),
    trajectory: risk.analyzeTrajectory(trace),
    timing: risk.analyzeTiming(trace)
  };

  const record = {
    meta: {
      label, participant, condition,
      ua: s.device?.ua, startedAt: s.collected_at, durationMs: s.duration_ms,
      sampleHz: s.diagnostics?.motion_hz, source: 'user-provided-real-device-export', originalSessionId: s.session_id
    },
    features, taps, trace, imu
  };

  const id = `${label}_${participant}_${condition}_${s.trial}_${Date.now()}_${written}`;
  fs.writeFileSync(path.join(SESSIONS_DIR, `${id}.json`), JSON.stringify(record, null, 2));
  written++;
  console.log(`${s.session_id} -> ${condition}, ${taps.length} taps, ${imu.length} imu samples, impulseRatio=${features.imu.impulseRatio}`);
}

console.log(`\nwrote ${written} session file(s) to ${SESSIONS_DIR}`);
