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

브라우저에서 `http://localhost:8787` 접속. 탭으로 나뉜 도구 모음이 아니라
**하나의 이어지는 흐름**이다: 문자로 링크가 옴 → 자동으로 L1(도메인)+L2(페이지
렌더링) 판정 → 위험하면 차단 화면, 아니면 실제 은행 앱처럼 계좌·은행·금액을
직접 입력하는 이체 화면 → 확인 → 서버가 서명한 위험도에 따라 필요하면 흔들기
챌린지(L4) → 완료/차단 결과 화면. 우하단 🛠 버튼이 검증랩(신호 오실로스코프)과
수집(L3 학습 데이터 녹화) 같은 개발자 도구를 별도 화면으로 연다 — 주 흐름에서는
안 보이게 뺐을 뿐 기능은 그대로다.

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

## Vercel 배포

```bash
npm i -g vercel   # 최초 1회
vercel             # 저장소 루트에서 실행, 로그인 후 안내대로
```

레포 루트의 `vercel.json`이 `server/src/app.js`(API)와 `server/public/`(정적
파일)을 각각 서버리스 함수/정적 자산으로 배포하도록 라우팅한다. 단,
**두 가지는 배포 환경에서 동작이 달라진다**:

- **수집 도구(세션 저장)**: 서버리스 함수는 파일시스템이 읽기 전용이라
  `/api/session/export`가 저장을 시도하지 않고 바로 "이 환경은 저장을
  지원하지 않는다"는 메시지를 반환한다. 실제 학습 데이터 수집은 여전히
  로컬에서 `npm start`로 돌려야 한다 — 애초에 폰을 직접 조작해야 하는
  작업이라 공개 배포 여부와 무관하게 로컬 워크플로다.
- **L2(페이지 렌더링)**: Vercel엔 시스템 Chromium이 없어서 `playwright-core`
  + `@sparticuz/chromium`(서버리스용 경량 바이너리) 조합으로 전환된다.
  일반적으로 쓰이는 패턴이지만, **이 세션은 Vercel 계정이 없어 실제 배포에서
  검증하지 못했다** — 배포 후 링크검사 흐름이 실제로 페이지를 렌더링하는지
  꼭 확인할 것. 실패하면 `/api/l2/check`가 502를 반환하고 클라이언트는
  "페이지를 불러오지 못했습니다"로 처리하므로 나머지 흐름(L1·L3·L4)은
  영향받지 않는다.

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
