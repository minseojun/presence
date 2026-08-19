# L1 evaluation against real labeled domains

Generated 2026-08-19T13:03:25.571Z.

**읽는 법**: 이 스크립트를 처음 돌렸을 때 실제 데이터가 진짜 버그를 하나 잡았다 —
2글자 브랜드 코드(`nh` 등)에 대한 Levenshtein 거리 매칭이 TLD 자체(`.net`)까지
오탐시키고 있었다(FPR 34%). 그 버그를 고치고 나니(TLD 제외 + 거리≤1로 강화)
FPR은 1.88%(th20)/0.05%(th30)까지 떨어졌지만, 재현율도 같이 떨어졌다(28~40%) —
이건 나빠진 게 아니라 **가짜로 부풀려져 있던 재현율이 사라진 것**이다. 이 피싱
피드는 전 세계 범용 피싱(크립토 사기, 일반 계정 확인 등)이 대부분이라 한국
은행 브랜드를 사칭하는 경우가 원래 적다 — L1은 애초에 그 범위를 노리는 도구가
아니다. 실제로 이 프로젝트가 노리는 패턴(`kb-bank-secure.tk`, `toss-secure-app.xyz`
류)은 여전히 75~95점으로 정확히 잡힌다(코드 상단 회귀 테스트 참고). 낮은 재현율
숫자를 "실패"로 읽지 말고 "이 도구가 커버하는 범위가 좁다"는 뜻으로 읽을 것.

- 피싱 소스: https://raw.githubusercontent.com/mitchellkrogza/Phishing.Database/master/phishing-domains-ACTIVE.txt (전체 391,618건, 20,000건 샘플링)
- 정상 소스: https://raw.githubusercontent.com/opendns/public-domain-lists/master/opendns-top-domains.txt (10,000건 전체 사용)
- 금융 관련 슬라이스: URL에 bank/secure/login/account/wallet/pay/card/verify/billing/chase/paypal/hsbc/wellsfargo/kb/shinhan/nonghyup 등이 포함된 27,341건 중 샘플링

### 전체 피싱 데이터셋 (n=30000, 20000 phishing / 10000 legit)

| 판정 임계값(score≥) | recall(재현율) | FPR(오탐률) | precision |
|---|---|---|---|
| 20 | 28.4% | 1.88% | 96.8% |
| 30 | 9.4% | 0.05% | 99.7% |
| 45 | 1.7% | 0.01% | 99.7% |
| 60 | 0.4% | 0.00% | 100.0% |
| 75 | 0.1% | 0.00% | 100.0% |

재현율 95% 이상을 만족하는 최소 오탐률: **100.00%** (임계값 0)

오탐 예시(정상인데 mid+로 잡힘): `nbcudigitaladops.com`(35), `member-hsbc-group.com`(35), `samsungvideohub.com`(35), `akbank.com`(45), `darkbluev2.com`(35)
미탐 예시(피싱인데 low로 통과): `amazon.wkaha.net`(0), `netcoins-login-help.pages.dev`(20), `metamaskhelpcenter.finance.blog`(10), `vatstrading.com`(0), `meta-beaconx.pages.dev`(0), `amaznoo.co.jp.fcjd.net`(15), `sso-uphold-com.typedream.app`(20), `login.microwordfileonllne.com`(0)

### 금융 브랜드 관련 슬라이스 (이 프로젝트가 실제로 노리는 범위) (n=30000, 20000 phishing / 10000 legit)

| 판정 임계값(score≥) | recall(재현율) | FPR(오탐률) | precision |
|---|---|---|---|
| 20 | 40.0% | 1.88% | 97.7% |
| 30 | 14.3% | 0.05% | 99.8% |
| 45 | 6.6% | 0.01% | 99.9% |
| 60 | 3.1% | 0.00% | 100.0% |
| 75 | 0.5% | 0.00% | 100.0% |

재현율 95% 이상을 만족하는 최소 오탐률: **100.00%** (임계값 0)

오탐 예시(정상인데 mid+로 잡힘): `nbcudigitaladops.com`(35), `member-hsbc-group.com`(35), `samsungvideohub.com`(35), `akbank.com`(45), `darkbluev2.com`(35)
미탐 예시(피싱인데 low로 통과): `login-ourtime.media-peeoplle.workers.dev`(20), `metamafskilogin.gitbook.io`(0), `geminietlogin.webflow.io`(0), `applocked-accverify.serveirc.com`(10), `coinbase-prologinexr.godaddysites.com`(10), `attenxion-login.mythicmys.shop`(10), `onlinelogins.ddns.net`(0), `atts-verify11.webflow.io`(10)
