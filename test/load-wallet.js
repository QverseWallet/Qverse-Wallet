/*
 * Loads the wallet's browser-side crypto libraries into an isolated VM context
 * so they can be exercised from Node without a browser.
 *
 * Script order mirrors popup/index.html exactly; secure-random.js must stay
 * last because it replaces exports from crypto-min.js and coin.js.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

const SCRIPTS = [
  "app/js/crypto-min.js",
  "app/js/crypto-sha256.js",
  "app/js/crypto-sha256-hmac.js",
  "app/js/sha512.js",
  "app/js/ripemd160.js",
  "app/js/jsbn.js",
  "app/js/ellipticcurve.js",
  "app/js/aes.js",
  "app/js/coin.js",
  "app/js/secure-random.js"
];

function loadWallet(options = {}) {
  const scripts = options.scripts || SCRIPTS;
  const sandbox = {
    crypto: require("crypto").webcrypto,
    console,
    navigator: { language: "en-US", userAgent: "node-test" },
    screen: { height: 1080, width: 1920, colorDepth: 24, availHeight: 1040, availWidth: 1920, pixelDepth: 24 },
    history: { length: 1 },
    document: {
      location: { protocol: "https:" },
      getElementById: () => null
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  for (const rel of scripts) {
    const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
    vm.runInContext(code, sandbox, { filename: rel });
  }
  return sandbox;
}

/*
 * Minimal test runner shared by the suites.
 *
 * `await fn()` is load-bearing: an earlier version called fn() without
 * awaiting, so every async test reported "ok" the instant it started and its
 * assertion failures became silently-swallowed unhandled rejections. Whole
 * suites passed while testing nothing.
 */
function makeRunner() {
  const tests = [];

  // A rejection escaping a test must fail the run, not vanish.
  let stray = null;
  process.on("unhandledRejection", (err) => { stray = stray || err; });

  return {
    test: (name, fn) => tests.push([name, fn]),
    run: async () => {
      let passed = 0, failed = 0;
      for (const [name, fn] of tests) {
        try {
          await fn();
          console.log(`  ok    ${name}`);
          passed++;
        } catch (err) {
          console.log(`  FAIL  ${name}`);
          console.log(`        ${err.message}`);
          failed++;
        }
      }
      // Let any pending rejection surface before we decide the exit code.
      await new Promise(r => setImmediate(r));
      if (stray) {
        console.log(`  FAIL  <unhandled rejection outside a test>`);
        console.log(`        ${stray.message || stray}`);
        failed++;
      }
      console.log(`\n${passed} passed, ${failed} failed`);
      process.exit(failed === 0 ? 0 : 1);
    }
  };
}

module.exports = { loadWallet, makeRunner, SCRIPTS, ROOT, vm };
