// Lightweight visual-similarity signal for L2 — "looks like a bank login
// page but isn't on a bank's domain." Not CLIP/ResNet embeddings (no ML
// runtime for that here, see LIMITATIONS.md); this is an average-hash
// (aHash) perceptual hash instead: cheap, dependency-light (sharp only),
// and good enough to catch "someone cloned a generic bank-login layout."
const sharp = require('sharp');

const HASH_SIZE = 16; // 16x16 grayscale -> 256-bit hash

// A mobile login screenshot is mostly blank background around a small
// centered card — hashing the full frame at 8x8/16x16 made every page
// (bank login or not) collapse to nearly the same "mostly white" hash,
// making the signal useless (verified empirically: two different bank
// mockups came out bit-identical). Cropping to the central content region
// first fixes it: two distinct bank-template mockups then land at Hamming
// distance ~22/256, while a news-article page and a bare unbranded login
// form land at ~87-128/256 — a real, usable gap.
const CROP = { xFrac: 0.08, yFrac: 0.08, wFrac: 0.84, hFrac: 0.55 };

async function computeAHash(imageBuffer) {
  const meta = await sharp(imageBuffer).metadata();
  const left = Math.round(meta.width * CROP.xFrac), top = Math.round(meta.height * CROP.yFrac);
  const width = Math.round(meta.width * CROP.wFrac), height = Math.round(meta.height * CROP.hFrac);
  const { data } = await sharp(imageBuffer)
    .extract({ left, top, width, height })
    .resize(HASH_SIZE, HASH_SIZE, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (const v of data) sum += v;
  const mean = sum / data.length;
  let hash = 0n;
  for (const v of data) hash = (hash << 1n) | (v >= mean ? 1n : 0n);
  return hash.toString(16).padStart(HASH_SIZE * HASH_SIZE / 4, '0');
}

function hammingDistance(hexA, hexB) {
  let a = BigInt('0x' + hexA), b = BigInt('0x' + hexB);
  let x = a ^ b, count = 0;
  while (x) { count += Number(x & 1n); x >>= 1n; }
  return count;
}

// Similarity as 0..1 (1 = identical) over the hash.
function similarity(hexA, hexB) {
  return 1 - hammingDistance(hexA, hexB) / (HASH_SIZE * HASH_SIZE);
}

module.exports = { computeAHash, hammingDistance, similarity, HASH_SIZE };
