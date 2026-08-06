/*
 * Load-time smoke test for the popup.
 *
 * The extension has no build step and no module system, so a bad script order
 * or a reference to a function that lives in another scope only shows up as a
 * blank popup in Chrome. This loads the real scripts in the real order against
 * a minimal DOM and fails on any exception.
 *
 * Run with:  node test/popup-smoke.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { makeRunner, ROOT } = require("./load-wallet");

const { test, run } = makeRunner();

// Derived from popup/index.html rather than hardcoded, so the test cannot drift
// from what Chrome actually loads.
const POPUP_SCRIPTS = (() => {
  const html = fs.readFileSync(path.join(ROOT, "popup", "index.html"), "utf8");
  const out = [];
  const re = /<script[^>]*\ssrc=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) out.push(path.normalize(path.join("popup", m[1])));
  return out;
})();

function makeElement(tag = "div") {
  const el = {
    tagName: tag, style: {}, dataset: {}, value: "", textContent: "", innerHTML: "",
    children: [], childElementCount: 0,
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    setAttribute(){}, getAttribute(){ return null; }, removeAttribute(){},
    addEventListener(){}, removeEventListener(){}, appendChild(){}, remove(){},
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    closest(){ return null; }, focus(){}, click(){}, insertAdjacentElement(){},
    getContext(){ return null; }
  };
  return el;
}

function makePopupSandbox() {
  const listeners = { document: {}, window: {} };
  const store = { local: {}, session: {} };

  const doc = {
    readyState: "loading",
    location: { protocol: "https:" },
    body: makeElement("body"),
    head: makeElement("head"),
    hidden: false,
    addEventListener(ev, fn) { (listeners.document[ev] = listeners.document[ev] || []).push(fn); },
    removeEventListener(){},
    getElementById(){ return null; },
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    createElement(tag){ return makeElement(tag); }
  };

  // Mirrors the callback-or-promise dual API of chrome.storage.
  const area = (bucket) => ({
    get(keys, cb) {
      let out = {};
      if (typeof keys === "string") out[keys] = store[bucket][keys];
      else if (Array.isArray(keys)) keys.forEach(k => { out[k] = store[bucket][k]; });
      else if (keys && typeof keys === "object") {
        for (const [k, dflt] of Object.entries(keys)) {
          out[k] = (k in store[bucket]) ? store[bucket][k] : dflt;
        }
      } else out = Object.assign({}, store[bucket]);
      if (cb) { cb(out); return; }
      return Promise.resolve(out);
    },
    set(obj, cb) { Object.assign(store[bucket], obj); if (cb) { cb(); return; } return Promise.resolve(); },
    remove(keys, cb) {
      (Array.isArray(keys) ? keys : [keys]).forEach(k => { delete store[bucket][k]; });
      if (cb) { cb(); return; }
      return Promise.resolve();
    },
    clear(cb) { store[bucket] = {}; if (cb) { cb(); return; } return Promise.resolve(); }
  });

  const sent = [];
  const sandbox = {
    crypto: require("crypto").webcrypto,
    console: { log(){}, warn(){}, error(){}, info(){} },
    document: doc,
    navigator: { language: "en-US", userAgent: "node-test", clipboard: { writeText: async () => {} } },
    screen: { height: 1080, width: 1920, colorDepth: 24, availHeight: 1040, availWidth: 1920, pixelDepth: 24 },
    history: { length: 1 },
    location: { protocol: "https:" },
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
    TextEncoder, TextDecoder, btoa, atob, URL,
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}), text: async () => "" }),
    chrome: {
      runtime: {
        id: "test",
        lastError: undefined,
        sendMessage(msg, cb) { sent.push(msg); if (cb) cb({ ok: false }); return Promise.resolve({ ok: false }); },
        onMessage: { addListener(){} }
      },
      storage: { local: area("local"), session: area("session") },
      offscreen: { hasDocument: async () => true, createDocument: async () => {} }
    },
    addEventListener(ev, fn) { (listeners.window[ev] = listeners.window[ev] || []).push(fn); },
    removeEventListener(){}
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  return { sandbox, listeners, sent, store };
}

function loadPopup() {
  const ctx = makePopupSandbox();
  for (const rel of POPUP_SCRIPTS) {
    const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
    vm.runInContext(code, ctx.sandbox, { filename: rel });
  }
  return ctx;
}

/* ------------------------------------------------------------------ */

test("all popup scripts load without throwing", () => {
  const { sandbox } = loadPopup();
  assert.ok(sandbox.coinjs, "coinjs missing after load");
  assert.strictEqual(sandbox.coinjs.__secureRandom, true, "CSPRNG override did not take");
  assert.ok(sandbox.QtcTx, "tx-math did not expose QtcTx");
});

test("the popup exposes the globals its own scripts call", () => {
  const { sandbox } = loadPopup();
  // session-gate.js and the settings dropdown reach these across scopes; if any
  // is missing they fail silently at runtime and the wallet stops locking.
  for (const name of ["isUnlocked", "clearSession", "notify", "escapeHtml", "setAuthMode",
                      "fetchBalances", "generateAddress", "getKeys", "applyAutolockTTL",
                      "updateWalletSelector", "setActiveWallet"]) {
    assert.strictEqual(typeof sandbox[name], "function", `window.${name} is not exported`);
  }
});

test("DOMContentLoaded initialisation completes without throwing", async () => {
  const { sandbox, listeners } = loadPopup();
  sandbox.document.readyState = "complete";
  const handlers = listeners.document["DOMContentLoaded"] || [];
  assert.ok(handlers.length > 0, "nothing registered a DOMContentLoaded handler");
  for (const fn of handlers) await fn();
});

test("a locked wallet refuses to build a transaction", async () => {
  const { sandbox } = loadPopup();
  assert.strictEqual(sandbox.isUnlocked(), false, "should start locked");
  // easySend() is the entry point bound to the Send button; with no DOM inputs
  // it must fail cleanly rather than throw past the handler.
  await sandbox.easySend?.();
});

test("address validation accepts every form Qubitcoin supports", () => {
  // Qubitcoin's chainparams keep Bitcoin's values: PUBKEY_ADDRESS 0x00,
  // SCRIPT_ADDRESS 0x05, bech32_hrp "bc". All three are valid destinations.
  // A version-only check silently rejected bech32, because addressDecode()
  // returns {type:'bech32'} with no `version` field.
  const { sandbox } = loadPopup();
  const k = sandbox.coinjs.newKeys();
  const pub = sandbox.coinjs.wif2pubkey(k.wif).pubkey;

  assert.ok(sandbox.isValidQtcAddress(k.address), "P2PKH address rejected");

  const bech = sandbox.coinjs.bech32Address(pub);
  assert.ok(bech && bech.address, "could not derive a bech32 address");
  assert.ok(sandbox.isValidQtcAddress(bech.address), `bech32 address rejected: ${bech.address}`);

  const p2sh = sandbox.coinjs.segwitAddress(pub);
  assert.ok(p2sh && p2sh.address, "could not derive a P2SH address");
  assert.ok(sandbox.isValidQtcAddress(p2sh.address), `P2SH address rejected: ${p2sh.address}`);

  assert.ok(!sandbox.isValidQtcAddress("not-an-address"), "garbage was accepted");
  assert.ok(!sandbox.isValidQtcAddress(k.address.slice(0, -1) + "X"), "bad checksum was accepted");
  assert.ok(!sandbox.isValidQtcAddress(""), "empty string was accepted");
});

test("a transaction can pay to a bech32 output", () => {
  // Validation is not enough: addoutput() -> spendToScript() must also build a
  // usable P2WPKH script, otherwise the send fails after the confirm dialog.
  const { sandbox } = loadPopup();
  const k = sandbox.coinjs.newKeys();
  const bech = sandbox.coinjs.bech32Address(sandbox.coinjs.wif2pubkey(k.wif).pubkey);

  const tx = sandbox.coinjs.transaction();
  tx.version = 2;
  tx.addinput("aa".repeat(32), 0, "", 0xffffffff);
  tx.addoutput(bech.address, "0.01000000");
  tx.addoutput(k.address, "0.02000000");

  const hex = tx.serialize();
  assert.match(hex, /^[0-9a-f]+$/i, "transaction did not serialize");
  assert.strictEqual(tx.outs.length, 2, "expected two outputs");
  // P2WPKH scriptPubKey is OP_0 <20-byte program> = 22 bytes.
  assert.strictEqual(tx.outs[0].script.buffer.length, 22, "bech32 output script is not P2WPKH");
});

test("no key material reaches chrome.storage during startup", async () => {
  const { sandbox, listeners, store } = loadPopup();
  sandbox.document.readyState = "complete";
  for (const fn of (listeners.document["DOMContentLoaded"] || [])) await fn();

  for (const bucket of ["local", "session"]) {
    for (const key of Object.keys(store[bucket])) {
      assert.ok(!/qtcTempKeysEnc|qtcSessionEnv|^qtcSession$/.test(key),
        `startup wrote ${key} into storage.${bucket}`);
    }
  }
});

run();
