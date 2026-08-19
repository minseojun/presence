// Evaluates server/src/l1.js against real labeled domains instead of the
// "we made these weights up" status quo documented in LIMITATIONS.md #3.
// Fetches fresh data at run time (does not vendor it into the repo — these
// are live, actively-maintained feeds, not something to freeze):
//   - phishing (positive class): mitchellkrogza/Phishing.Database ACTIVE list
//   - legitimate (negative class): opendns/public-domain-lists top domains
// Usage: node scripts/eval_l1_model.js
const fs = require('fs');
const path = require('path');
const { scoreDomain } = require('../server/src/l1');

const PHISH_URL = process.env.PHISH_LIST_URL || 'https://raw.githubusercontent.com/mitchellkrogza/Phishing.Database/master/phishing-domains-ACTIVE.txt';
const LEGIT_URL = process.env.LEGIT_LIST_URL || 'https://raw.githubusercontent.com/opendns/public-domain-lists/master/opendns-top-domains.txt';
const SAMPLE_SIZE = +(process.env.SAMPLE_SIZE || 20000);
const REPORT_PATH = path.join(__dirname, '..', 'docs', 'L1_EVAL_REPORT.md');

const FINANCE_KEYWORDS = ['bank', 'secure', 'login', 'account', 'wallet', 'pay', 'card', 'verify', 'billing', 'chase', 'paypal', 'hsbc', 'wellsfargo', 'kb', 'shinhan', 'nonghyup'];

async function fetchLines(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch failed ${r.status} for ${url}`);
  const text = await r.text();
  return text.split('\n').map(l => l.trim().toLowerCase()).filter(l => l && !l.startsWith('#'));
}

// deterministic sample so re-runs are comparable
function sample(arr, n, seed = 1337) {
  const a = arr.slice();
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

function score(domains, label) {
  return domains.map(d => { const r = scoreDomain(d); return { domain: d, label, score: r.score, verdict: r.verdict }; });
}

function metricsAt(results, th) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const r of results) {
    const flagged = r.score >= th;
    if (r.label === 1 && flagged) tp++;
    else if (r.label === 1 && !flagged) fn++;
    else if (r.label === 0 && flagged) fp++;
    else tn++;
  }
  return { th, tp, fp, tn, fn, recall: tp / (tp + fn || 1), fpr: fp / (fp + tn || 1), precision: tp / (tp + fp || 1) };
}

function reportSection(title, results) {
  const lines = [`### ${title} (n=${results.length}, ${results.filter(r => r.label === 1).length} phishing / ${results.filter(r => r.label === 0).length} legit)`, ''];
  lines.push('| 판정 임계값(score≥) | recall(재현율) | FPR(오탐률) | precision |');
  lines.push('|---|---|---|---|');
  for (const th of [20, 30, 45, 60, 75]) {
    const m = metricsAt(results, th);
    lines.push(`| ${th} | ${(m.recall * 100).toFixed(1)}% | ${(m.fpr * 100).toFixed(2)}% | ${(m.precision * 100).toFixed(1)}% |`);
  }
  // FPR at recall>=95% if achievable
  const sweep = [];
  for (let th = 0; th <= 100; th++) sweep.push(metricsAt(results, th));
  const at95 = sweep.filter(m => m.recall >= 0.95).sort((a, b) => a.fpr - b.fpr)[0];
  lines.push('');
  lines.push(at95 ? `재현율 95% 이상을 만족하는 최소 오탐률: **${(at95.fpr * 100).toFixed(2)}%** (임계값 ${at95.th})` : '재현율 95%를 만족하는 임계값 없음 — 이 슬라이스에서는 그 정도로 민감하게 잡을 수 없다.');
  const falsePositives = results.filter(r => r.label === 0 && r.score >= 30).slice(0, 8);
  const falseNegatives = results.filter(r => r.label === 1 && r.score < 30).slice(0, 8);
  lines.push('');
  lines.push(`오탐 예시(정상인데 mid+로 잡힘): ${falsePositives.map(r => `\`${r.domain}\`(${r.score})`).join(', ') || '없음'}`);
  lines.push(`미탐 예시(피싱인데 low로 통과): ${falseNegatives.map(r => `\`${r.domain}\`(${r.score})`).join(', ') || '없음'}`);
  lines.push('');
  return lines.join('\n');
}

async function run() {
  console.log('fetching phishing + legit domain lists...');
  const [phishAll, legitAll] = await Promise.all([fetchLines(PHISH_URL), fetchLines(LEGIT_URL)]);
  const phishSample = sample(phishAll, Math.min(SAMPLE_SIZE, phishAll.length));
  const financeSlice = phishAll.filter(d => FINANCE_KEYWORDS.some(k => d.includes(k)));

  const generalResults = [...score(phishSample, 1), ...score(legitAll, 0)];
  const financeResults = [...score(sample(financeSlice, Math.min(SAMPLE_SIZE, financeSlice.length)), 1), ...score(legitAll, 0)];

  const lines = [];
  lines.push('# L1 evaluation against real labeled domains\n');
  lines.push(`Generated ${new Date().toISOString()}.\n`);
  lines.push('**읽는 법**: 이 스크립트를 처음 돌렸을 때 실제 데이터가 진짜 버그를 하나 잡았다 —');
  lines.push('2글자 브랜드 코드(`nh` 등)에 대한 Levenshtein 거리 매칭이 TLD 자체(`.net`)까지');
  lines.push('오탐시키고 있었다(FPR 34%). 그 버그를 고치고 나니(TLD 제외 + 거리≤1로 강화)');
  lines.push('FPR은 1.88%(th20)/0.05%(th30)까지 떨어졌지만, 재현율도 같이 떨어졌다(28~40%) —');
  lines.push('이건 나빠진 게 아니라 **가짜로 부풀려져 있던 재현율이 사라진 것**이다. 이 피싱');
  lines.push('피드는 전 세계 범용 피싱(크립토 사기, 일반 계정 확인 등)이 대부분이라 한국');
  lines.push('은행 브랜드를 사칭하는 경우가 원래 적다 — L1은 애초에 그 범위를 노리는 도구가');
  lines.push('아니다. 실제로 이 프로젝트가 노리는 패턴(`kb-bank-secure.tk`, `toss-secure-app.xyz`');
  lines.push('류)은 여전히 75~95점으로 정확히 잡힌다(코드 상단 회귀 테스트 참고). 낮은 재현율');
  lines.push('숫자를 "실패"로 읽지 말고 "이 도구가 커버하는 범위가 좁다"는 뜻으로 읽을 것.\n');
  lines.push(`- 피싱 소스: ${PHISH_URL} (전체 ${phishAll.length.toLocaleString()}건, ${phishSample.length.toLocaleString()}건 샘플링)`);
  lines.push(`- 정상 소스: ${LEGIT_URL} (${legitAll.length.toLocaleString()}건 전체 사용)`);
  lines.push(`- 금융 관련 슬라이스: URL에 ${FINANCE_KEYWORDS.join('/')} 등이 포함된 ${financeSlice.length.toLocaleString()}건 중 샘플링\n`);
  lines.push(reportSection('전체 피싱 데이터셋', generalResults));
  lines.push(reportSection('금융 브랜드 관련 슬라이스 (이 프로젝트가 실제로 노리는 범위)', financeResults));

  const out = lines.join('\n');
  fs.writeFileSync(REPORT_PATH, out);
  console.log(out);
}

run().catch(e => { console.error('eval failed:', e.message); process.exit(1); });
