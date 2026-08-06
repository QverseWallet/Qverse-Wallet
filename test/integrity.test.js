/*
 * Packaging integrity checks.
 *
 * The wallet has no build step, so a renamed or deleted file only surfaces as a
 * blank popup at runtime. These tests catch it before packaging.
 *
 * Run with:  node test/integrity.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { makeRunner, ROOT } = require("./load-wallet");

const { test, run } = makeRunner();

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

function scriptSrcs(htmlRel) {
  const html = read(htmlRel);
  const dir = path.dirname(htmlRel);
  const out = [];
  const re = /<script[^>]*\ssrc=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) out.push({ raw: m[1], rel: path.normalize(path.join(dir, m[1])) });
  return out;
}

test("every script referenced by the popup exists", () => {
  for (const s of scriptSrcs("popup/index.html")) {
    assert.ok(exists(s.rel), `popup/index.html references missing script ${s.raw}`);
  }
});

test("every script referenced by the options page exists", () => {
  for (const s of scriptSrcs("options/index.html")) {
    assert.ok(exists(s.rel), `options/index.html references missing script ${s.raw}`);
  }
});

test("secure-random.js loads after coin.js and is last", () => {
  // It replaces exports from crypto-min.js and coin.js, so order is load-bearing.
  const srcs = scriptSrcs("popup/index.html").map(s => s.rel);
  const coin = srcs.indexOf(path.normalize("app/js/coin.js"));
  const secure = srcs.indexOf(path.normalize("app/js/secure-random.js"));
  assert.ok(coin >= 0, "coin.js is not loaded");
  assert.ok(secure >= 0, "secure-random.js is not loaded");
  assert.ok(secure > coin, "secure-random.js must load after coin.js");

  const cryptoMin = srcs.indexOf(path.normalize("app/js/crypto-min.js"));
  assert.ok(secure > cryptoMin, "secure-random.js must load after crypto-min.js");
});

test("tx-math.js loads before popup.js", () => {
  const srcs = scriptSrcs("popup/index.html").map(s => s.rel);
  const txMath = srcs.indexOf(path.normalize("popup/tx-math.js"));
  const popup = srcs.indexOf(path.normalize("popup/popup.js"));
  assert.ok(txMath >= 0 && popup >= 0, "both scripts must be loaded");
  assert.ok(txMath < popup, "popup.js depends on QtcTx at call time");
});

test("manifest is valid and its referenced files exist", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.strictEqual(manifest.manifest_version, 3);

  assert.ok(exists(manifest.background.service_worker), "service worker missing");
  assert.ok(exists(manifest.action.default_popup), "popup missing");
  assert.ok(exists(manifest.options_page), "options page missing");
  for (const [size, rel] of Object.entries(manifest.icons)) {
    assert.ok(exists(rel), `icon ${size} missing at ${rel}`);
  }
});

test("every host fetched by the code is declared in host_permissions", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const allowed = new Set(
    manifest.host_permissions.map(p => new URL(p.replace(/\*$/, "")).host)
  );

  // pool.qverse.pro was fetched by renderMining() without a host permission.
  const sources = ["popup/popup.js", "background/service-worker.js", "popup/session-gate.js"];
  const found = new Set();
  for (const rel of sources) {
    const code = read(rel);
    // Only URLs that are actually fetched, not ones used as link targets.
    const re = /(?:fetch|fetchAPI)\s*\(\s*[`'"]([^`'"]*https:\/\/[^`'"/]+)/g;
    let m;
    while ((m = re.exec(code))) {
      const host = m[1].replace(/^.*https:\/\//, "");
      if (host) found.add(host);
    }
    const constRe = /https:\/\/([a-z0-9.-]+)/gi;
    while ((m = constRe.exec(code))) found.add(m[1]);
  }

  for (const host of found) {
    // x.com / t.me / qverse.pro appear as anchor hrefs, which need no permission.
    if (["x.com", "t.me", "qverse.pro", "www.coinex.com", "github.com"].includes(host)) continue;
    assert.ok(allowed.has(host), `${host} is fetched but not in host_permissions`);
  }
});

test("no key material is written to chrome.storage", () => {
  // v0.3.3 stored the session AES key alongside its ciphertext under
  // qtcTempKeysEnc / qtcSession. Those writes must not come back.
  const code = read("popup/popup.js") + read("options/options.js") + read("offscreen/offscreen.js");
  for (const blob of ["qtcTempKeysEnc", "qtcSessionEnv"]) {
    const writes = code.match(new RegExp(`storage\\.session\\.set\\([^)]*${blob}`, "g"));
    assert.ok(!writes, `${blob} is being written to storage.session again`);
  }
});

test("the insecure Math.random RNG is not reachable from the popup", () => {
  // crypto-min.js still ships the weak randomBytes; secure-random.js overrides
  // it. Assert the override is present and unconditional.
  // Strip comments first: secure-random.js quotes the original broken guard in
  // its header, and that documentation must not trip the check.
  const secure = read("app/js/secure-random.js")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(secure.includes('harden(window.Crypto.util, "randomBytes"'),
    "randomBytes override is missing");
  assert.ok(!/typeof\s+Crypto\.util\.randomBytes\s*!==\s*["']function["']/.test(secure),
    "the override is guarded again -- that is the bug that made the original patch dead code");
  assert.ok(read("popup/popup.js").includes("assertSecureRandom"),
    "popup.js no longer checks that the CSPRNG is active");
});

test("no orphaned popup scripts are left in the tree", () => {
  const referenced = new Set(scriptSrcs("popup/index.html").map(s => path.basename(s.rel)));
  const onDisk = fs.readdirSync(path.join(ROOT, "popup")).filter(f => f.endsWith(".js"));
  const orphans = onDisk.filter(f => !referenced.has(f));
  assert.strictEqual(orphans.length, 0, `unreferenced popup scripts: ${orphans.join(", ")}`);
});

run();
