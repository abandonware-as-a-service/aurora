// Aurora cryptographic hashing & formatting utilities (shared by browser dApp and Node tests).
// Uses Web Crypto API (crypto.subtle.digest('SHA-256', ...)) which is native in both modern
// browsers and Node.js 20+, matching DuskVM's `abi::sha256` byte for byte.
import {accountToHex, formatLuxToDusk, parseDuskToLux, LUX_SCALE} from './vendor/dusk-connect.js';

export {accountToHex, formatLuxToDusk, parseDuskToLux, LUX_SCALE};

const encoder = new TextEncoder();
const ANSWER_DOMAIN = encoder.encode('aurora:answer:v1:');
const COMMIT_DOMAIN = encoder.encode('aurora:commit:v1:');
const SHADOW_DOMAIN = encoder.encode('aurora:shadow:v1:');

export function normalizeAnswer(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

export function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  const clean = String(hex ?? '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('Expected an even-length hexadecimal string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function accountBytes(base58Account) {
  const hex = accountToHex(base58Account);
  return hexToBytes(hex);
}

export function concatBytes(...arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function u64LeBytes(value) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(value), true);
  return new Uint8Array(buf);
}

export async function sha256Bytes(data) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

// Synchronous FIPS 180-4 SHA-256 for WASM host query (`env.hq("sha256")`) execution in browser & Node.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Sync(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const bitLen = bytes.length * 8;
  const padLen = ((bytes.length + 9 + 63) & ~63);
  const padded = new Uint8Array(padLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, idx) => outView.setUint32(idx * 4, word, false));
  return out;
}

// Matches `Aurora::hash_answer` in contract/src/lib.rs:
// SHA-256("aurora:answer:v1:" || normalize_answer(answer))
export async function hashAnswer(answer) {
  const norm = encoder.encode(normalizeAnswer(answer));
  const bytes = await sha256Bytes(concatBytes(ANSWER_DOMAIN, norm));
  return Array.from(bytes);
}

// Matches `Aurora::hash_commitment` in contract/src/lib.rs:
// SHA-256("aurora:commit:v1:" || vault_id_le8 || solver_pk_96 || answer_hash_32 || salt_trimmed)
export async function hashCommitment(vaultId, solverBase58, answerHashBytes, salt) {
  const idBytes = u64LeBytes(vaultId);
  const pkBytes = accountBytes(solverBase58);
  const ansBytes = Uint8Array.from(answerHashBytes);
  const saltBytes = encoder.encode(String(salt ?? '').trim());
  const bytes = await sha256Bytes(concatBytes(COMMIT_DOMAIN, idBytes, pkBytes, ansBytes, saltBytes));
  return Array.from(bytes);
}

// Matches `Aurora::make_shadow_tag` in contract/src/lib.rs:
// "Shadow #" + first 3 bytes (6 hex chars) of SHA-256("aurora:shadow:v1:" || solver_pk_96)
export async function computeShadowTag(solverBase58) {
  const pkBytes = accountBytes(solverBase58);
  const digest = await sha256Bytes(concatBytes(SHADOW_DOMAIN, pkBytes));
  return `Shadow #${bytesToHex(digest.slice(0, 3))}`;
}

export function randomSaltHex(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function shortKey(key) {
  if (typeof key !== 'string' || key.length <= 16) return String(key ?? '');
  return `${key.slice(0, 7)}…${key.slice(-5)}`;
}
