# L1 evaluation against real labeled domains

Generated 2026-08-27T14:28:19.662Z.

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

- 피싱 소스: https://raw.githubusercontent.com/mitchellkrogza/Phishing.Database/master/phishing-domains-ACTIVE.txt (전체 391,753건, 20,000건 샘플링)
- 정상 소스: https://raw.githubusercontent.com/opendns/public-domain-lists/master/opendns-top-domains.txt (10,000건 전체 사용)
- 금융 관련 슬라이스: URL에 bank/secure/login/account/wallet/pay/card/verify/billing/chase/paypal/hsbc/wellsfargo/kb/shinhan/nonghyup 등이 포함된 27,344건 중 샘플링

### 전체 피싱 데이터셋 (n=30000, 20000 phishing / 10000 legit)

| 판정 임계값(score≥) | recall(재현율) | FPR(오탐률) | precision |
|---|---|---|---|
| 20 | 79.6% | 9.84% | 94.2% |
| 30 | 76.3% | 5.67% | 96.4% |
| 45 | 71.5% | 2.03% | 98.6% |
| 60 | 58.0% | 0.37% | 99.7% |
| 75 | 47.2% | 0.14% | 99.9% |

재현율 95% 이상을 만족하는 최소 오탐률: **60.95%** (임계값 5)

오탐 예시(정상인데 mid+로 잡힘): `google.com.tr`(32), `ssl-images-amazon.com`(52), `google.com.br`(32), `google.com.vn`(32), `amazon.co.uk`(33), `amazon.co.jp`(33), `amazon.com.br`(33), `display-trk.com`(32)
미탐 예시(피싱인데 low로 통과): `ofxl.top`(15), `alojatuempresa.com`(8), `payflkn.cc`(4), `aselyaloveu.com`(6), `5510006.net`(10), `yddho.cn`(3), `anvietlong.com`(7), `mbtaccess7c.info`(8)

### 금융 브랜드 관련 슬라이스 (이 프로젝트가 실제로 노리는 범위) (n=30000, 20000 phishing / 10000 legit)

| 판정 임계값(score≥) | recall(재현율) | FPR(오탐률) | precision |
|---|---|---|---|
| 20 | 93.5% | 9.84% | 95.0% |
| 30 | 88.8% | 5.67% | 96.9% |
| 45 | 84.0% | 2.03% | 98.8% |
| 60 | 70.7% | 0.37% | 99.7% |
| 75 | 57.3% | 0.14% | 99.9% |

재현율 95% 이상을 만족하는 최소 오탐률: **12.09%** (임계값 12)

오탐 예시(정상인데 mid+로 잡힘): `google.com.tr`(32), `ssl-images-amazon.com`(52), `google.com.br`(32), `google.com.vn`(32), `amazon.co.uk`(33), `amazon.co.jp`(33), `amazon.com.br`(33), `display-trk.com`(32)
미탐 예시(피싱인데 low로 통과): `applepaymentpartner.com`(8), `cardslive.org`(7), `amacardupdata.xyz`(15), `kchase.org`(6), `accountuk-secure.net`(23), `mywallets-sync.com`(26), `bendigomobile-account.com`(29), `mit1t1secure.com`(7)
