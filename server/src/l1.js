// L1: static link/domain triage. Purely lexical/offline — no WHOIS or
// certificate-transparency lookups yet (see docs/LIMITATIONS.md).
//
// Two scorers run per domain: a hand-tuned heuristic (below, unchanged
// behavior — every consumer that depended on its exact thresholds keeps
// working) and, if `scripts/train_l1_model.js` has been run, a real logistic
// regression trained on ~400k labeled real domains (docs/L1_ML_TRAINING_REPORT.md).
// The returned score is the max of the two (an OR-of-detectors ensemble —
// either one flagging is enough), so training the ML model can only ever
// catch more, never silently suppress what the heuristic already caught.
const fs = require('fs');
const path = require('path');

const BRANDS = [
  'kbstar', 'kbcard', 'kb', 'shinhan', 'wooribank', 'woori', 'hanabank', 'hana',
  'nonghyup', 'nhbank', 'nh', 'ibk', 'kakaobank', 'kakao', 'tossbank', 'toss',
  'kbank', 'citibank', 'citi', 'scbank', 'suhyup', 'busanbank', 'dgb', 'kdb',
  'samsungcard', 'samsung', 'hyundaicard', 'hyundai', 'lottecard', 'lotte', 'bccard', 'bc',
  // Fictional brand used by the in-app demo scenario (server/public/index.html's
  // sample SMS impersonates this instead of a real bank) — keeps the demo's
  // default phishing link self-consistently flagged without touching a real
  // bank's name. Real-domain evaluation (scripts/eval_l1_model.js) is
  // unaffected since this token doesn't collide with any real-world domain.
  'danggeunbank', 'danggeun'
];
const OFFICIAL_DOMAINS = new Set([
  'kbstar.com', 'kbcard.com', 'shinhan.com', 'wooribank.com', 'hanabank.com',
  'nonghyup.com', 'nhbank.com', 'ibk.co.kr', 'kakaobank.com', 'tossbank.com',
  'kbank.co.kr', 'citibank.co.kr', 'standardchartered.co.kr', 'suhyup-bank.com',
  'busanbank.co.kr', 'dgb.co.kr', 'kdb.co.kr', 'samsungcard.com',
  'hyundaicard.com', 'lottecard.co.kr', 'bccard.com'
]);
const SUSPICIOUS_TLDS = new Set(['tk', 'ml', 'ga', 'cf', 'gq', 'xyz', 'top', 'click', 'support', 'work', 'link', 'live', 'icu']);
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'is.gd', 'buff.ly', 'goo.gl', 'me2.do', 'url.kr']);

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  }
  return dp[a.length][b.length];
}

const ML_WEIGHTS_PATH = path.join(__dirname, '..', 'data', 'model', 'l1-weights.json');
let mlModel = null;
try { mlModel = JSON.parse(fs.readFileSync(ML_WEIGHTS_PATH, 'utf8')); } catch (_) { /* not trained yet — heuristic-only until scripts/train_l1_model.js runs */ }

// Fixed feature order the trained model expects — must match scripts/train_l1_model.js.
const ML_FEATURE_NAMES = ['isIp', 'isPunycode', 'isShortener', 'isSuspiciousTld', 'brandLookalike', 'brandSubstring', 'brandPlusGenericWord', 'subdomainDepth', 'hyphenCount', 'digitRatio', 'hostEntropy', 'closestDistCapped', 'hostLenNorm'];
function mlFeatureVector(f) {
  return [
    f.isIp ? 1 : 0, f.isPunycode ? 1 : 0, f.isShortener ? 1 : 0, f.isSuspiciousTld ? 1 : 0,
    f.brandLookalike ? 1 : 0, f.brandSubstring ? 1 : 0, f.brandPlusGenericWord ? 1 : 0,
    Math.min(5, f.subdomainDepth), Math.min(5, f.hyphenCount), f.digitRatio, f.hostEntropy,
    Math.min(5, f.closestDist == null ? 5 : f.closestDist), Math.min(1, f.host.length / 40)
  ];
}
function mlScoreOf(f) {
  if (!mlModel) return null;
  const x = mlFeatureVector(f);
  const z = mlModel.b + x.reduce((s, xi, i) => s + xi * mlModel.w[i], 0);
  return Math.round(100 / (1 + Math.exp(-z)));
}

function entropy(s) {
  const freq = {};
  for (const c of s) freq[c] = (freq[c] || 0) + 1;
  return -Object.values(freq).reduce((sum, n) => { const p = n / s.length; return sum + p * Math.log2(p); }, 0);
}

function scoreDomain(rawUrl) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`); }
  catch { return { score: 100, verdict: 'high', reason: 'unparseable-url', features: {} }; }

  const host = u.hostname.toLowerCase();
  const bareHost = host.replace(/^www\./, '');
  const labels = bareHost.split('.');
  const tld = labels[labels.length - 1];
  const registrable = labels.length >= 2 ? labels.slice(-2).join('.') : bareHost;
  const subdomainDepth = Math.max(0, labels.length - 2);

  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(bareHost);
  const isPunycode = labels.some(l => l.startsWith('xn--'));
  const isShortener = SHORTENERS.has(registrable);
  const isSuspiciousTld = SUSPICIOUS_TLDS.has(tld);
  const isOfficial = OFFICIAL_DOMAINS.has(registrable);

  const tokens = bareHost.split(/[.\-]/).filter(Boolean);
  // Exclude the TLD from fuzzy comparison — real evaluation against ~400k
  // labeled domains (scripts/eval_l1_model.js) showed short brand codes like
  // "nh" (농협) sit within Levenshtein distance 2 of "net" itself, flagging
  // huge numbers of unrelated .net domains as brand lookalikes. Also require
  // a minimum brand length for the fuzzy match at all: edit-distance ≤2 from
  // a 2-3 char string is satisfied by nearly anything that short, so it's
  // not a meaningful "lookalike" signal — those short codes are still caught
  // via exact token/substring match below, just not via typo-tolerance.
  const nonTldTokens = tokens.slice(0, -1);
  const FUZZY_MIN_BRAND_LEN = 5;
  let closestBrand = null, closestDist = Infinity;
  for (const tok of nonTldTokens) for (const b of BRANDS) {
    if (b.length < FUZZY_MIN_BRAND_LEN) continue;
    const d = levenshtein(tok, b);
    if (d < closestDist) { closestDist = d; closestBrand = b; }
  }
  const exactBrandToken = tokens.some(tok => BRANDS.includes(tok));
  // distance<=2 against real data (scripts/eval_l1_model.js) still coincidentally
  // matched unrelated real brands sharing a generic suffix (usbank.com ~
  // "nhbank", woot.com ~ "woori") — distance<=1 keeps real single-typo
  // squats (toos->toss, shinhon->shinhan) while dropping those collisions.
  const brandLookalike = !isOfficial && closestDist === 1;
  const brandSubstring = !isOfficial && (exactBrandToken || BRANDS.some(b => bareHost.includes(b)));
  const genericSuspiciousWords = ['secure', 'login', 'verify', 'update', 'bank', 'account', 'safe', 'auth', 'app', 'app-center', 'confirm', 'wallet'];
  const brandPlusGenericWord = brandSubstring && tokens.some(t => genericSuspiciousWords.includes(t));

  const hyphenCount = (bareHost.match(/-/g) || []).length;
  const digitRatio = (bareHost.match(/\d/g) || []).length / bareHost.length;
  const hostEntropy = entropy(bareHost);

  const features = {
    host, registrable, tld, subdomainDepth, isIp, isPunycode, isShortener,
    isSuspiciousTld, isOfficial, brandLookalike, brandSubstring, brandPlusGenericWord,
    closestBrand, closestDist: isFinite(closestDist) ? closestDist : null, hyphenCount,
    digitRatio: +digitRatio.toFixed(2), hostEntropy: +hostEntropy.toFixed(2)
  };

  if (isOfficial) return { score: 0, verdict: 'low', reason: 'official-domain', features, mlScore: 0 };

  let heuristicScore = 0;
  if (isIp) heuristicScore += 30;
  if (isPunycode) heuristicScore += 25;
  if (isShortener) heuristicScore += 20;
  if (isSuspiciousTld) heuristicScore += 15;
  if (brandLookalike) heuristicScore += 45;
  if (brandSubstring && !brandLookalike) heuristicScore += 25;
  if (brandPlusGenericWord) heuristicScore += 25; // e.g. kb-bank-secure.tk — brand token + banking-flavored word
  if (subdomainDepth >= 3) heuristicScore += 15;
  if (hyphenCount >= 2) heuristicScore += 10;
  if (digitRatio > 0.3) heuristicScore += 10;
  if (hostEntropy > 3.8) heuristicScore += 10;
  heuristicScore = Math.min(100, heuristicScore);

  const mlScore = mlScoreOf(features);
  const score = mlScore == null ? heuristicScore : Math.max(heuristicScore, mlScore);

  const verdict = score >= 60 ? 'high' : score >= 30 ? 'mid' : 'low';
  return { score, heuristicScore, mlScore, verdict, features };
}

module.exports = { scoreDomain, OFFICIAL_DOMAINS, BRANDS, ML_FEATURE_NAMES, mlFeatureVector };
