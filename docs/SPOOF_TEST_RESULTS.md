# PRESENCE spoof-test findings (auto-generated, re-run with `npm run test:spoof`)

Run at 2026-08-19T06:58:00.874Z against http://127.0.0.1:8787

## A. Real taps, flat IMU (baseline — simulates scrcpy/AnyDesk driving a phone at rest)
```
score=81 band=high requireChallenge=true
```
**PASS** — correctly flagged high risk.

## B. Browser-level spoof — synthetic DeviceMotionEvent fired in lockstep with synthetic taps
```
score=0 band=low requireChallenge=false
```
**KNOWN GAP CONFIRMED** — hand-scripted `dispatchEvent(DeviceMotionEvent)` measurably lowered the risk score. The touch–IMU signal trusts any event named `devicemotion` regardless of origin; it cannot yet distinguish real hardware from a page script (or a malicious accessibility service) that fires the same event. Only a native/OS-level attestation (e.g. Play Integrity API) closes this — flagged in docs/LIMITATIONS.md, not solved by this codebase.

## C. Direct API forgery — bypassing the browser, POSTing hand-crafted "perfect normal session" telemetry
```
score=0 band=low requireChallenge=false
```
This is *expected* to look low-risk — telemetry authenticity (that it came from a real device at all) is a separate, unsolved problem from scoring-given-telemetry. It is why L4 (the shake challenge) exists as the enforcement point, not the L3 score alone: even a forged low-risk score cannot self-authorize a transfer, since `requireChallenge` still routes through a server-graded physical challenge before `challenge-result` returns `authorized`.

## D. Forged challenge-result — replaying a valid signature over a tampered token payload
```
{"status":401,"body":{"error":"invalid-or-tampered-token"}}
```
**PASS** — HMAC signature check rejected the tampered payload; token integrity holds.
