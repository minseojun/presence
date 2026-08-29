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

## 심사용 대시보드 (`/demo`)

`http://localhost:8787/demo` — 심사위원이 직접 폰을 갖고 오지 않아도 L3/L4를
그 자리에서 눌러볼 수 있는 데스크톱용 대시보드. "원격제어" vs "실제 사람"
합성 텔레메트리를 토글해 실제 프로덕션 엔드포인트(`/api/session/decision`,
`/api/session/challenge-result`)를 그대로 호출하고, IMU 타임라인 차트와 흔들기
챌린지(진짜 흔들기 vs 차량 진동 1회) 결과를 실시간으로 보여준다. 별도 프레임워크나
배포 없이 기존 앱과 같은 서버·같은 URL에서 동작한다.

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

## L1 실데이터 평가

```bash
node scripts/eval_l1_model.js   # 인터넷에서 실제 피싱 피드 + 정상 도메인 목록을 매번 새로 받아옴
```

`server/src/l1.js`를 실제 피싱 피드(~39만 건)와 실제 상위 도메인(1만 건)으로
평가해 재현율/오탐률을 계산한다. 이 스크립트가 실제로 진짜 버그를 하나
잡아냈다 — 결과는 `docs/L1_EVAL_REPORT.md` 참고.

```bash
node scripts/train_l1_model.js   # 위와 같은 실제 데이터로 진짜 로지스틱 회귀를 학습
```

`server/data/model/l1-weights.json`에 학습된 가중치를 저장하고, 서버는
재시작 없이 다음 요청부터 바로 읽는다(휴리스틱 점수와 `max()`로 앙상블 —
휴리스틱이 이미 잡던 걸 놓치게 만들 수는 없다). 학습 리포트는
`docs/L1_ML_TRAINING_REPORT.md`, 결합된 시스템의 실측 재현율/오탐률은
다시 `npm run eval:l1`로 확인. 자세한 트레이드오프(재현율은 크게 올랐지만
새로운 오탐 패턴도 같이 생김)는 `docs/LIMITATIONS.md` 3번 항목 참고.

## AI 문자 분석 (L0, Claude API)

문자 미끼 화면에 있는 "🤖 AI 문자 분석" 카드는 URL이 아니라 문자/통화
스크립트 **텍스트 내용**을 Claude에게 분석시켜 사회공학적 패턴을 한국어로
설명해준다(`server/src/l0.js`, `POST /api/l0/analyze-message`). 이 기능만
`ANTHROPIC_API_KEY` 환경변수가 필요하다:

```bash
cd server
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Vercel이면 프로젝트 설정의 Environment Variables에 `ANTHROPIC_API_KEY`를
추가할 것. **키가 없으면** 이 카드는 502가 아니라 명확한 안내 메시지를
보여주고, 나머지 L1~L4는 전혀 영향받지 않는다 — 서버 권위 판정(이체
차단/승인)의 일부가 아니라 사용자에게 보여주는 보조 설명 기능이기
때문이다. 프롬프트 인젝션 완화, 대규모 평가 부재 등 정직한 한계는
`docs/LIMITATIONS.md` 15번 항목 참고.

## L2 시각 유사도 레퍼런스 재생성

```bash
cd server
npm run build:visual
```

`server/reference-pages/*.html`(직접 만든 은행 로그인 목업)을 렌더링해
지각적 해시를 `server/data/model/visual-reference.json`에 저장한다.
목업을 수정했거나, 실제 공식 도메인 스크린샷으로 교체하려면 다시 실행할 것.
자세한 원리와 검증 결과는 `docs/LIMITATIONS.md` 2번 항목 참고.

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
    app.js       Express 진입점 — /api/l0, /api/l1, /api/l2, /api/session/*, /api/demo/*
    risk.js      L3 특징 추출 + 융합 (서버 권위 버전)
    l0.js        AI 문자/통화 분석 (Claude API 호출, ANTHROPIC_API_KEY 필요)
    l1.js        도메인 어휘 판정 + 학습된 로지스틱 회귀 앙상블
    l2.js        Playwright 랜딩페이지 판정
    visual.js    L2용 지각적 해시(perceptual hash) 시각 유사도
    sign.js      HMAC 서명/검증 — 클라이언트가 판정을 위조 못 하게
    store.js     수집 세션 파일 저장
  public/
    index.html   클라이언트 (표시 전용, 최종 판단은 서버 응답만 신뢰)
    demo.html    심사용 L3/L4 인터랙티브 대시보드 (/demo)
  reference-pages/
    bank-login-*.html   L2 시각 유사도용 은행 로그인 목업(직접 제작)
  scripts/
    build_visual_reference.js   위 목업을 렌더링해 해시 생성
  test/
    spoof_test.js
  data/
    sessions/    수집된 녹화 (학습 입력)
    model/
      weights.json           학습된(또는 기본) L3 융합 가중치
      l1-weights.json        학습된 L1 로지스틱 회귀 가중치 (train_l1_model.js 실행 시 생성)
      visual-reference.json  L2 시각 유사도 레퍼런스 해시
scripts/
  train_l3_model.js
  eval_l1_model.js
  train_l1_model.js
docs/
  LIMITATIONS.md
  SPOOF_TEST_RESULTS.md      (test:spoof 실행 시 생성)
  L3_TRAINING_REPORT.md      (train_l3_model.js 실행 시 생성)
  L1_EVAL_REPORT.md          (eval_l1_model.js 실행 시 생성)
  L1_ML_TRAINING_REPORT.md   (train_l1_model.js 실행 시 생성)
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
