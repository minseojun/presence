# L3 auto-calibration — real-device validation

Generated 2026-08-19T13:42:55.336Z from 13 normal-labeled session(s) in server/data/sessions/.

| 참여자 | 조건 | 탭 수 | 기본값(0.35) impulseRatio | 자동보정 floor | 자동보정 impulseRatio |
|---|---|---|---|---|---|
| s01 | desk | 14 | 0.071 | 0.13 | 0.071 |
| s01 | desk | 12 | 0.833 | 0.08 | 0.917 |
| s01 | handheld | 11 | 0.636 | 0.16 | 0.636 |
| s01 | handheld | 12 | 0.167 | 수렴 안 됨 | — |
| s02 | desk | 10 | 0.8 | 0.16 | 0.9 |
| s02 | desk | 14 | 0.857 | 0.19 | 0.857 |
| s02 | handheld | 15 | 0.2 | 수렴 안 됨 | — |
| s02 | handheld | 12 | 0.083 | 수렴 안 됨 | — |
| s03 | desk | 11 | 0.727 | 0.12 | 1 |
| s03 | desk | 9 | 1 | 0.13 | 1 |
| s03 | handheld | 12 | 0.5 | 수렴 안 됨 | — |
| s03 | handheld | 13 | 0.154 | 수렴 안 됨 | — |
| s03 | handheld | 13 | 0.308 | 수렴 안 됨 | — |

수렴한 세션: 7/13 (5개 이상의 탭이 z-score 기준을 스스로 통과해야 보정이 시작됨)
수렴한 세션들만 비교 — 기본값 평균 impulseRatio: 0.703, 자동보정 평균: 0.769, 악화된 세션 수: 0

조건별 기본값 impulseRatio 평균 — desk: 0.715 (n=6), handheld: 0.293 (n=7)
desk가 확연히 높다 — 책상에 고정된 폰은 터치 충격이 감쇠 없이 그대로 꽂히고, 손에 든 폰은 배경 흔들림(sway) 때문에 상대적으로 덜 도드라진다는 사용자 원 실험 결과와 정확히 일치한다.
handheld 세션 중 자동보정이 수렴한 건: 1/7 — 배경 흔들림 자체가 z-score 게이트를 통과할 만큼 뚜렷한 임펄스가 드물어서, handheld 조건에서는 보정이 더 느리게(또는 아예 안) 수렴한다. 아직 열려 있는 문제.