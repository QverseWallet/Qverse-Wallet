/*
 * secure-random.js — replaces coinbin's insecure entropy sources with the
 * platform CSPRNG (crypto.getRandomValues).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * crypto-min.js ships `Crypto.util.randomBytes` implemented as
 * `Math.floor(Math.random() * 256)`, and coin.js's `coinjs.random()` draws
 * characters with `Math.random()` too. Every entropy source feeding
 * `coinjs.newPrivkey()` was therefore V8's xorshift128+ PRNG, whose internal
 * state is recoverable from a handful of outputs. Private keys generated that
 * way are guessable.
 *
 * A previous attempt to patch this lived in popup.js as:
 *     if (typeof Crypto.util.randomBytes !== "function") { ...override... }
 * The guard is inverted: randomBytes IS already a function (the insecure one),
 * so the override never ran.
 *
 * This file MUST be loaded after crypto-min.js and coin.js so it can replace
 * their exports, and before any key is generated. The overrides are
 * unconditional and non-writable.
 */
(function () {
  "use strict";

  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("secure-random: platform CSPRNG unavailable; refusing to generate keys");
  }

  function randomByteArray(n) {
    var b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
  }

  function toHex(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
    return s;
  }

  // Lock a property so a later-loading script cannot restore the weak version.
  function harden(obj, name, value) {
    Object.defineProperty(obj, name, {
      value: value,
      writable: false,
      configurable: false,
      enumerable: true
    });
  }

  /* ---- 1. Crypto.util.randomBytes ------------------------------------- */
  if (typeof window.Crypto === "undefined" || !window.Crypto.util) {
    throw new Error("secure-random: Crypto.util missing; check script order in index.html");
  }
  harden(window.Crypto.util, "randomBytes", function (n) {
    return Array.from(randomByteArray(n));
  });

  /* ---- 2. coinjs.random ------------------------------------------------ */
  if (typeof window.coinjs === "undefined") {
    throw new Error("secure-random: coinjs missing; must load after coin.js");
  }

  // Unbiased character selection via rejection sampling. The original used
  // `Math.floor(Math.random() * 62)` against an 89-char alphabet, which was
  // both insecure and unable to reach 27 of its own characters.
  var ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  harden(window.coinjs, "random", function (length) {
    var l = length || 25;
    var out = "";
    var limit = 256 - (256 % ALPHABET.length); // reject above this to stay uniform
    while (out.length < l) {
      var buf = randomByteArray(l);
      for (var i = 0; i < buf.length && out.length < l; i++) {
        if (buf[i] < limit) out += ALPHABET.charAt(buf[i] % ALPHABET.length);
      }
    }
    return out;
  });

  /* ---- 3. coinjs.newPrivkey ------------------------------------------- */
  // secp256k1 group order. A valid private key is an integer in [1, n-1].
  var SECP256K1_N = BigInt(
    "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"
  );

  // Draw 32 fresh CSPRNG bytes and reject anything outside [1, n-1] rather than
  // reducing mod n, which would bias the low end of the range.
  harden(window.coinjs, "newPrivkey", function () {
    for (var attempt = 0; attempt < 512; attempt++) {
      var hex = toHex(randomByteArray(32));
      var value = BigInt("0x" + hex);
      if (value > 0n && value < SECP256K1_N) return hex;
    }
    // 512 consecutive rejections is impossible with a working CSPRNG
    // (p < 2^-8000); treat it as a broken RNG and fail closed.
    throw new Error("secure-random: CSPRNG rejection loop exhausted");
  });

  /* ---- 4. Self-test ---------------------------------------------------- */
  // Proves at load time that the overrides took effect and produce distinct,
  // in-range keys. Sets the flag generateAddress() checks before creating keys.
  (function selfTest() {
    var a = window.coinjs.newPrivkey();
    var b = window.coinjs.newPrivkey();
    if (a === b) throw new Error("secure-random: self-test failed, RNG repeats");
    if (!/^[0-9a-f]{64}$/.test(a)) throw new Error("secure-random: self-test failed, bad key format");
    if (window.Crypto.util.randomBytes(8).length !== 8) {
      throw new Error("secure-random: self-test failed, randomBytes broken");
    }
    harden(window.coinjs, "__secureRandom", true);
  })();
})();
