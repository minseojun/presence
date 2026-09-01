# PRESENCE spoof-test findings (auto-generated, re-run with `npm run test:spoof`)

Run at 2026-09-01T05:13:50.357Z against http://127.0.0.1:8787

## A. Real taps, flat IMU (baseline — simulates scrcpy/AnyDesk driving a phone at rest)
```
score=84 band=high requireChallenge=true
```
**PASS** — correctly flagged high risk.

## B. Browser-level spoof — synthetic DeviceMotionEvent fired in lockstep with synthetic taps
```
score=3 band=low requireChallenge=false
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

## E. Vehicle single-bump — one ~150ms speed-bump burst during the shake challenge (regression test for a real bug report)
```
{"payload":{"sessionId":"20793bc3-e2d3-4124-8ab3-6d0927372cd0","authorized":false,"energy":1,"threshold":8.58,"iat":1788239630353},"signature":"b30d309ec908529c67573d7d46771ae943724387d5f3b510ff656eb66bf196e6"}
```
**PASS** — a single momentary jolt (e.g. a car hitting one speed bump while the victim is being socially engineered mid-drive) is correctly rejected. Fixed by requiring temporally-separated *bursts* of qualifying samples (gap > 150ms starts a new burst) instead of a raw qualifying-sample count, which a single ~150ms jolt could satisfy outright at 60Hz sampling.

## F. Bumpy road, three separated bumps — known residual gap (documented, not fixed)
```
{"payload":{"sessionId":"20793bc3-e2d3-4124-8ab3-6d0927372cd0","authorized":true,"energy":3,"threshold":8.41,"iat":1788239630356},"signature":"958c98daf7ba3bd7b4cafc6a59f0796564464df1dade7bc3d970589c5eae1996"}
```
**KNOWN GAP** — a genuinely rough road producing 3+ well-separated large bumps within the challenge window still authorizes, since each bump is its own burst and burst-counting alone cannot tell "3 deliberate shakes" from "3 distinct road bumps". Closing this fully needs frequency-domain shake-signature analysis (a real hand shake oscillates ~2-6Hz with alternating direction; a bump is a single-direction impulse) — not implemented here for lack of real calibration data to validate against, consistent with this project's policy of not guessing new physical-sensor constants. Tracked in docs/LIMITATIONS.md.
