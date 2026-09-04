# PRESENCE

원격제어 금융사기(보이스피싱형 원격조작) 방어를 위한 프로토타입. 핵심은
4계층 서버 판정 — L1(링크 판정) · L2(랜딩페이지 판정) · L3(세션 무결성) ·
L4(물리적 현존 챌린지) — 이고, 그 앞에 문자 내용 자체를 읽는 L0(AI 문자
분석, Claude)가 보조로 붙는다.

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
**하나의 이어지는 흐름**이다: 먼저 상황을 짚어주는 안내 화면("당신은 방금,
문자 한 통을 받았습니다")을 지나면, 이미 와있는 문자(가상 은행 "당근은행"
명의) 화면에서 "AI로 문자 분석"(L0)과 "링크 검사하기" 버튼을 함께 볼 수
있다 → 링크 검사하기를 누르면 자동으로 L1(도메인)+L2(페이지 렌더링) 판정
→ 위험하면 차단 화면(콜센터로 직접 확인하라는 경고 포함), 아니면 실제
은행 앱처럼 계좌·은행(가상 은행명 목록)·금액을 직접 입력하는 이체 화면 →
확인(L3: 세션 무결성 판정) → 서버가 서명한 위험도에 따라 필요하면 궤적
그리기 + 흔들기(애니메이션 포함) 챌린지(L4) → 완료/차단 결과 화면. 위험이
실제로 감지되어 흐름이 멈출 때마다 "은행에 전화해서 확인하세요" 경고가
화면에 뜬다. 각 화면에 그 순간 어느 계층이 작동 중인지 `L0`~`L4` 배지로
표시해서, 코드를 안 봐도 흐름만 따라가면 각 단계가 어디서 뭘 하는지 바로
보인다.

이체가 성공/차단으로 끝나거나 링크가 차단될 때마다 그 판정 결과가 자동
기록된다 — 우하단 📊 버튼이 그 이력을 신호별 상세 지표(터치-IMU 정합,
궤적 직선성, 흔들기 반전 횟수 등)와 함께 카드로 보여준다(브라우저 로컬
저장, 계정 연동 없음). 🛠 버튼은 검증랩(신호 오실로스코프)과 수집(L3
학습 데이터 녹화) 같은 개발자 도구를 별도 화면으로 연다 — 실제 이체
승인/차단 결정에는 관여하지 않는 검증·데이터 수집용 도구라는 설명이 그
화면 맨 위에 붙어 있다.

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

## 데이터 저장 (Vercel Blob)

Vercel은 서버리스 함수의 파일시스템이 읽기 전용이라, 배포된 URL에서
"데이터 수집" 탭의 "JSON 내보내기"를 눌러도 기본적으로는 저장이 안 되고
명확한 안내 메시지만 뜬다(`docs/LIMITATIONS.md` 13번 항목). Vercel Blob을
연결하면 이것도 저장된다 — 코드는 이미 준비돼 있고, 아래 절차만 하면 된다.

1. **Vercel 대시보드 → 해당 프로젝트 → Storage 탭 → "Create Database"
   → Blob 선택** → 저장소 이름 정하고 생성.
2. 생성하면 프로젝트에 자동으로 연결되면서 **`BLOB_READ_WRITE_TOKEN`
   환경변수가 자동으로 추가된다** — `ANTHROPIC_API_KEY`처럼 직접 값을
   복사해서 붙여넣을 필요가 없다.
3. **환경변수 추가만으로는 자동 재배포가 안 된다** — Vercel 대시보드에서
   최신 배포를 수동으로 Redeploy 한 번 해줘야 새 환경변수가 반영된다.
4. 이제 배포된 URL에서 "JSON 내보내기"를 누르면 실제로 저장되고,
   "업로드됨 (총 N건)"이 뜬다.

**Public/Private 저장소 주의**: Blob 저장소는 생성할 때 Public/Private
중 하나로 고정된다. 이 코드는 **Private를 기본값**으로 쓴다(원시
터치·동작 데이터라 추측 가능한 URL로 아무나 못 열어보는 게 맞다고
판단). 혹시 저장소를 Public으로 만들었다면 환경변수
`PRESENCE_BLOB_ACCESS=public`을 추가해야 한다 — 안 맞으면 "cannot use
public access on a private store" 같은 에러로 저장이 실패한다(실제로
겪은 사례, `docs/LIMITATIONS.md` 13번 항목 참고).

**브라우저에서 바로 비교해보기(코드/토큰 필요 없음)**: "정상"과 "원격
조작" 세션을 각각 하나 이상 올렸다면, 배포된 URL의 개발자 도구 → 데이터
수집 탭 → "☁️ 서버에 저장된 세션 불러와서 비교" 버튼 하나로 서버(또는
Blob)에 저장된 세션 중 각 라벨의 최신 것을 자동으로 불러와 신호별
비교표를 보여준다 — 컴퓨터에 아무것도 설치하거나 토큰을 다룰 필요가
없다.

**학습 파이프라인과 연결하기**: `scripts/train_l3_model.js` 등은 로컬
파일시스템(`server/data/sessions/`)만 읽으므로, Blob에 쌓인 세션을 학습
전에 로컬로 내려받아야 한다:

```bash
cd server
BLOB_READ_WRITE_TOKEN=... npm run pull:blob
```

토큰은 Vercel 대시보드의 해당 Blob 저장소 → ".env.local" 탭에서 복사.
이미 로컬에 있는 파일은 덮어쓰지 않고 새로 추가된 것만 받아온다.

**정직한 이력**: 이 세션엔 원래 Vercel 계정이 없어 진짜 토큰으로 검증 못한
채로 코드를 만들었는데, 사용자가 실제로 Blob 저장소를 만들고 연결해보니
바로 위 Public/Private 문제가 실제로 발생했다 — `access:'public'`으로
하드코딩돼 있던 게 원인이었고, 지금 버전은 그걸 고친 상태다. 다만 이
수정 이후 진짜 저장→`npm run pull:blob` 다운로드까지 전체 경로가
성공하는지는 아직 재확인 전이다. 자세한 내용은 `docs/LIMITATIONS.md`
13번 항목 참고.

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

- **수집 도구(세션 저장)**: 서버리스 함수는 파일시스템이 읽기 전용이라,
  Vercel Blob을 연결하지 않으면 `/api/session/export`가 저장을 시도하지
  않고 명확한 안내 메시지를 반환한다. 위 "데이터 저장 (Vercel Blob)"
  절차대로 Blob을 연결하면 배포 환경에서도 저장된다. 다만 폰을 직접
  조작해야 데이터가 생기는 건 여전해서, 수집 자체는 배포 여부와 무관하게
  실기기가 있는 사람이 직접 눌러야 하는 작업이다.
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
    app.js       Express 진입점 — /api/l0, /api/l1, /api/l2, /api/session/*
    risk.js      L3 특징 추출 + 융합 (서버 권위 버전)
    l0.js        AI 문자/통화 분석 (Claude API 호출, ANTHROPIC_API_KEY 필요)
    l1.js        도메인 어휘 판정 + 학습된 로지스틱 회귀 앙상블
    l2.js        Playwright 랜딩페이지 판정
    visual.js    L2용 지각적 해시(perceptual hash) 시각 유사도
    sign.js      HMAC 서명/검증 — 클라이언트가 판정을 위조 못 하게
    store.js     수집 세션 저장 (로컬 파일시스템 또는 Vercel Blob)
  public/
    index.html   클라이언트 (표시 전용, 최종 판단은 서버 응답만 신뢰) — L0~L4 배지로
                 어느 화면에서 어느 계층이 작동하는지 표시
  reference-pages/
    bank-login-*.html   L2 시각 유사도용 은행 로그인 목업(직접 제작)
  scripts/
    build_visual_reference.js   위 목업을 렌더링해 해시 생성
    pull_blob_sessions.js       Vercel Blob에 쌓인 세션을 로컬로 내려받기
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
