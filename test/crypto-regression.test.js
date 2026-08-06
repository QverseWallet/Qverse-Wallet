/*
 * Regression tests for the wallet's cryptographic core.
 *
 * Run with:  node test/crypto-regression.test.js
 *
 * The headline test is `Math.random is never reached`: v0.3.3 and earlier
 * derived every private key from Math.random(), so booby-trapping it and
 * generating keys is the direct proof that the CSPRNG fix is live.
 */
"use strict";

const assert = require("assert");
const { loadWallet, makeRunner, vm } = require("./load-wallet");

const { test, run } = makeRunner();

/* ------------------------------------------------------------------ */

test("secure-random loads and flags itself active", () => {
  const w = loadWallet();
  assert.strictEqual(w.coinjs.__secureRandom, true, "__secureRandom flag not set");
});

test("Math.random is never reached during key generation", () => {
  const w = loadWallet();
  // Booby-trap the weak PRNG *inside* the sandbox realm, since Math there is a
  // context intrinsic rather than a property of the sandbox object.
  vm.runInContext(
    "Math.random = function () { throw new Error('Math.random() was called in the key generation path'); };",
    w
  );
  assert.throws(() => vm.runInContext("Math.random()", w), /was called/, "trap not installed");

  const keys = w.coinjs.newKeys();
  assert.ok(keys.address, "no address produced");
  assert.ok(keys.wif, "no WIF produced");
  assert.match(keys.privkey, /^[0-9a-f]{64}$/, "private key is not 32-byte hex");
});

test("randomBytes cannot be reverted to the weak implementation", () => {
  const w = loadWallet();
  const before = w.Crypto.util.randomBytes;
  try {
    w.Crypto.util.randomBytes = function () { return [1, 2, 3]; };
  } catch (e) { /* strict-mode callers get a TypeError, also fine */ }
  assert.strictEqual(w.Crypto.util.randomBytes, before, "randomBytes was overwritten");
});

test("private keys are unique and in the secp256k1 range", () => {
  const w = loadWallet();
  const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
  const seen = new Set();
  const SAMPLES = 200;

  for (let i = 0; i < SAMPLES; i++) {
    const hex = w.coinjs.newPrivkey();
    assert.match(hex, /^[0-9a-f]{64}$/, "malformed private key");
    const v = BigInt("0x" + hex);
    assert.ok(v > 0n && v < N, "private key outside [1, n-1]");
    seen.add(hex);
  }
  assert.strictEqual(seen.size, SAMPLES, "duplicate private keys generated");
});

test("generated keys have high bit-level entropy", () => {
  const w = loadWallet();
  // Count how often each of the 256 bit positions is set across many keys.
  // A healthy CSPRNG lands near 50%; Math.random-derived keys skew hard.
  const SAMPLES = 300;
  const counts = new Array(256).fill(0);

  for (let i = 0; i < SAMPLES; i++) {
    const hex = w.coinjs.newPrivkey();
    for (let byteIdx = 0; byteIdx < 32; byteIdx++) {
      const byte = parseInt(hex.substr(byteIdx * 2, 2), 16);
      for (let bit = 0; bit < 8; bit++) {
        if (byte & (1 << bit)) counts[byteIdx * 8 + bit]++;
      }
    }
  }

  // Generous bounds: with n=300 the 1-in-a-million band is roughly 35%-65%.
  for (let i = 0; i < 256; i++) {
    const ratio = counts[i] / SAMPLES;
    assert.ok(ratio > 0.3 && ratio < 0.7, `bit ${i} set ${(ratio * 100).toFixed(1)}% of the time`);
  }
});

test("WIF round-trips back to the same address", () => {
  const w = loadWallet();
  for (let i = 0; i < 25; i++) {
    const k = w.coinjs.newKeys();
    const back = w.coinjs.wif2address(k.wif);
    assert.strictEqual(back.address, k.address, "WIF -> address mismatch");
  }
});

test("generated addresses pass the wallet's own validation", () => {
  const w = loadWallet();
  for (let i = 0; i < 25; i++) {
    const k = w.coinjs.newKeys();
    const decoded = w.coinjs.addressDecode(k.address);
    assert.ok(decoded, "address failed to decode");
    assert.strictEqual(decoded.version, w.coinjs.pub, "unexpected address version byte");
  }
});

test("addressDecode rejects corrupted addresses", () => {
  const w = loadWallet();
  const k = w.coinjs.newKeys();
  // Flip a character in the middle; the base58 checksum must catch it.
  const chars = k.address.split("");
  chars[10] = chars[10] === "a" ? "b" : "a";
  const corrupted = chars.join("");
  assert.notStrictEqual(corrupted, k.address);
  assert.ok(!w.coinjs.addressDecode(corrupted), "corrupted address was accepted");
});

test("coinjs.random covers its full alphabet without bias", () => {
  const w = loadWallet();
  const s = w.coinjs.random(20000);
  const distinct = new Set(s.split(""));
  // The original drew `Math.floor(Math.random() * 62)` from an 89-character
  // alphabet that began with punctuation, so it emitted symbols like '!$%^'
  // and could never reach its own trailing digits. Assert the exact set.
  const expectedChars = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(""));
  assert.strictEqual(distinct.size, expectedChars.size, `expected ${expectedChars.size} distinct chars, got ${distinct.size}`);
  for (const c of distinct) {
    assert.ok(expectedChars.has(c), `unexpected character '${c}' outside the alphanumeric alphabet`);
  }
  const counts = {};
  for (const c of s) counts[c] = (counts[c] || 0) + 1;
  const expected = 20000 / 62;
  for (const c of distinct) {
    const dev = Math.abs(counts[c] - expected) / expected;
    assert.ok(dev < 0.25, `character '${c}' deviates ${(dev * 100).toFixed(1)}% from uniform`);
  }
});

/* ------------------------------------------------------------------ */

run();
