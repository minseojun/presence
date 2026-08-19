# 네이티브 앱 로드맵 — 웹 MVP 다음 단계

이 문서는 지금 구현하지 않는다. "왜 안 했는지"와 "다음엔 뭘 만들어야 하는지"를
구체적으로 남겨두기 위한 설계 문서다. 브라우저는 원리적으로 다른 앱의 존재를
알 수 없다(`docs/LIMITATIONS.md` #6) — 이 문서가 다루는 건 그 벽을 넘으려면
정확히 뭐가 필요한가다.

## 왜 브라우저로는 안 되는가

웹 페이지는 샌드박스 안에서 돈다. 다음 정보에 접근할 방법이 없다:
- 기기에 어떤 앱이 설치돼 있는지 (패키지 목록)
- 어떤 앱이 접근성 서비스(Accessibility Service) 권한을 갖고 있는지
- 화면 위에 다른 앱이 오버레이를 그리고 있는지
- 앱이 스토어를 통해 설치됐는지, 사이드로딩됐는지

이건 전부 OS 레벨 API라서 네이티브 앱(또는 최소한 앱에 내장된 SDK)이어야
접근 가능하다.

## 안드로이드 우선인 이유

기획서에서 이미 짚었듯 사이드로딩(APK 직접 설치)이 되는 건 안드로이드다.
iOS는 앱스토어 밖 설치가 막혀 있어 이 벡터 자체가 성립하기 어렵고, 그래서
iOS 사용자는 주로 2단계(가짜 사이트 입력형 — 이 프로젝트의 L1/L2가 이미
다루는 영역)로 공격받는다. 안드로이드 네이티브 SDK가 1순위인 이유가 이거다.

## 잡아야 할 신호와 실제 API

### 1. 설치 시점 — 정적 분석

```kotlin
val pm = packageManager
val apps = pm.getInstalledApplications(PackageManager.GET_META_DATA)
for (app in apps) {
    val installer = pm.getInstallerPackageName(app.packageName)
    // installer == null 또는 "com.google.android.packageinstaller" 등이면
    // 스토어가 아닌 사이드로딩 설치 — 특히 문자 링크 클릭 직후 설치된 앱이면 강한 신호
}
```

권한 조합도 같이 본다 (`PackageManager.getPackageInfo(..., GET_PERMISSIONS)`):
- `RECEIVE_SMS`/`READ_SMS` + `BIND_ACCESSIBILITY_SERVICE`를 **동시에** 요구하는
  사이드로딩 앱 — 정상 앱에서 거의 없는 조합, 룰 기반만으로도 정확도가 높음
- `SYSTEM_ALERT_WINDOW`(다른 앱 위에 그리기) 추가면 오버레이 공격 가능성 확정적

### 2. 실행 중 — 동적 감시

**접근성 서비스 활성화 목록**:
```kotlin
val enabled = Settings.Secure.getString(contentResolver,
    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
// 사이드로딩된 패키지가 여기 포함돼 있으면 실시간 화면 읽기/조작 권한 보유 확정
```

**포그라운드 앱 감시** (Usage Stats API, 사용자가 별도 권한을 허용해야 함):
자사 은행 앱이 포그라운드로 올라오는 순간, 그 위에 오버레이가 그려지는지
`WindowManager` 콜백/접근성 이벤트로 감지.

**콜 포워딩 상태**: `TelephonyManager` 관련 API로 착신전환 활성화 여부 확인 —
활성화돼 있으면 "진짜 은행에 전화해서 확인하라"는 안내 자체가 무력화된
상태라는 뜻이므로 별도 경고가 필요.

### 3. 이 프로젝트(웹 L1~L4)와의 통합 지점

네이티브 SDK가 별도로 도는 게 아니라, 지금 있는 서버 신뢰 구조에 다섯 번째
신호로 얹는 게 맞다:

```
클라이언트(네이티브 SDK) ──(device risk report)──▶ POST /api/session/decision
                                                       │
                                    risk.buildParts()에 다섯 번째 파트로 추가:
                                    parts.device = { p: deviceRiskScore, ok: true }
```

`server/src/risk.js`의 `buildParts`/`fuseRisk`는 이미 신호 하나가 없어도
(`ok:false`) 나머지로 커버리지 가중 융합을 하도록 짜여 있어서, 이 다섯 번째
신호를 추가하는 구조 변경 자체는 크지 않다 — 웹만 쓰는 사용자는 `device`
신호가 그냥 비활성으로 빠지고 L1~L4만으로 판단하면 된다.

## 왜 지금 안 만들었나 (정직하게)

1. **플랫폼이 다르다** — 이건 Kotlin/Android SDK 프로젝트고, 지금 스택(Node/
   Express/Playwright)과 코드를 공유하지 않는다. 별도 개발 트랙.
2. **실기기 필요** — 접근성 서비스 활성화, 사이드로딩 설치 같은 건 에뮬레이터로도
   일부 되지만 실제 악성 APK를 실기기에 설치해서 테스트하는 건 이 세션(클라우드
   컨테이너, 물리 기기 없음)에서 근본적으로 불가능한 일이다.
3. **배포 심사 이슈** — 접근성 서비스 목록을 읽는 앱은 구글 플레이 정책상
   별도 심사/정당한 사유 소명이 필요하다. 실제 배포하려면 이것도 고려해야 함.

## MVP 다음, 진짜 다음 단계

우선순위를 매기면:
1. 설치 시점 정적 분석(권한 조합 룰 기반)이 가장 비용 대비 효과가 큼 — 접근성+SMS
   동시 요구는 룰 하나로 거의 확정적 판정이 가능
2. 접근성 서비스 활성화 목록 실시간 감시가 두 번째 — 실행 중 탐지의 핵심
3. 오버레이/포그라운드 감시는 배터리·권한 부담이 커서 우선순위 낮음
