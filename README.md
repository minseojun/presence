# PRESENCE

원격제어 금융사기(보이스피싱형 원격조작) 방어를 위한 4계층 프로토타입.
L1(링크 판정) · L2(랜딩페이지 판정) · L3(세션 무결성) · L4(물리적 현존 챌린지).

이전 버전은 `index.html` 하나에 모든 로직(위험도 계산, 이체 승인/차단)이
클라이언트 JS로만 존재해 브라우저 콘솔로 우회 가능했다. 지금은 **점수 계산과
승인/차단 결정을 서버가 서명해서 내려주고, 클라이언트는 그 결과를 표시만
한다.** 자세한 위협 모델과 아직 못 푼 문제는 [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) 참고.

## 실행

```bash
cd server
npm install        # express, playwright (Chromium은 이미 설치된 걸 재사용)
npm start           # http://localhost:8787
```

브라우저에서 `http://localhost:8787` 접속. 탭 구성:

- **링크검사** — L1(도메인 어휘 특징) + L2(Playwright 렌더링 + DOM 신호) 판정
- **데모** — 모의 이체. 서버가 서명한 위험도에 따라 흔들기 챌린지(L4) 요구
- **검증랩** — 터치–IMU 오실로스코프, 궤적/타이밍 신호를 손끝으로 직접 확인
- **수집** — L3 학습 데이터를 녹화해 서버(`server/data/sessions/`)로 업로드

## 위조 저항성 테스트

```bash
cd server
npm run test:spoof   # 서버가 떠 있어야 함
```

Playwright로 실제 브라우저에서 (a) 정상 조작 없는 원격조작 패턴, (b) 배경
잡음 + 탭 동기화 burst로 IMU를 흉내 낸 정교한 스푸핑, (c) 브라우저를 아예
건너뛴 API 직접 위조, (d) 서명 토큰 변조 시도까지 4가지 공격을 실행하고
결과를 `docs/SPOOF_TEST_RESULTS.md`에 남긴다. **(b)는 현재 코드로 실제로
뚫린다** — 자세한 내용은 해당 리포트와 `LIMITATIONS.md` 1번 항목.

## L3 모델 학습

```bash
node scripts/train_l3_model.js              # server/data/sessions/의 실제 녹화 사용
node scripts/train_l3_model.js --synthetic  # 파이프라인 배관 점검용 (진짜 평가 아님)
```

세션이 10건 미만이면 학습을 건너뛰고 기존 기본 가중치를 유지한다. 결과는
`docs/L3_TRAINING_REPORT.md`와 `server/data/model/weights.json`(서버가 재시작
없이 바로 읽음)에 기록된다.

## 디렉터리

```
server/
  src/
    app.js       Express 진입점 — /api/l1, /api/l2, /api/session/*
    risk.js      L3 특징 추출 + 융합 (서버 권위 버전)
    l1.js        도메인 어휘 판정
    l2.js        Playwright 랜딩페이지 판정
    sign.js      HMAC 서명/검증 — 클라이언트가 판정을 위조 못 하게
    store.js     수집 세션 파일 저장
  public/
    index.html   클라이언트 (표시 전용, 최종 판단은 서버 응답만 신뢰)
  test/
    spoof_test.js
  data/
    sessions/    수집된 녹화 (학습 입력)
    model/weights.json  학습된(또는 기본) 융합 가중치
scripts/
  train_l3_model.js
docs/
  LIMITATIONS.md
  SPOOF_TEST_RESULTS.md      (test:spoof 실행 시 생성)
  L3_TRAINING_REPORT.md      (train_l3_model.js 실행 시 생성)
```

## 신뢰 경계

```
클라이언트 ──(raw taps/imu/trace)──▶ POST /api/session/decision
                                        │ risk.js가 점수·band 계산
                                        │ sign.js가 HMAC 서명
클라이언트 ◀──(서명된 payload)──────────┘
                                        (콘솔로 조작 불가 — 서명 재계산 시 불일치)
requireChallenge=true면
클라이언트 ──(IMU 샘플 + 서명된 토큰)──▶ POST /api/session/challenge-result
                                        │ 서버가 흔들기 에너지 채점
                                        │ 토큰 서명 재검증 (변조 시 401)
클라이언트 ◀──(서명된 authorized)───────┘
```
