/*
 * Integration tests for the vault and key-persistence path.
 *
 * These drive the real popup.js against a scripted DOM and chrome API, going
 * through the actual "Create wallet" button handler, because this is where
 * funds get lost: a key that is shown to the user but never persisted, or a
 * write that overwrites keys the wallet failed to read back.
 *
 * Run with:  node test/vault.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { makeRunner, ROOT } = require("./load-wallet");

const { test, run } = makeRunner();

const POPUP_SCRIPTS = (() => {
  const html = fs.readFileSync(path.join(ROOT, "popup", "index.html"), "utf8");
  const out = [];
  const re = /<script[^>]*\ssrc=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) out.push(path.normalize(path.join("popup", m[1])));
  return out;
})();

// Only these ids resolve to real elements; everything else stays null so the
// unrelated init paths short-circuit exactly as they do with a partial DOM.
const LIVE_IDS = ["password", "passwordConfirm", "passwordConfirmField", "notif", "createBtn", "unlockBtn"];

function makeElement(id) {
  const handlers = {};
  return {
    id, style: {}, dataset: {}, value: "", textContent: "", innerHTML: "", title: "",
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    setAttribute(){}, getAttribute(){ return null; },
    addEventListener(ev, fn){ (handlers[ev] = handlers[ev] || []).push(fn); },
    removeEventListener(){}, appendChild(){}, remove(){}, focus(){},
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    closest(){ return null; },
    __fire: async (ev) => { for (const fn of (handlers[ev] || [])) await fn({ stopPropagation(){}, preventDefault(){} }); },
    __handlers: handlers
  };
}

function makeSandbox() {
  const els = {};
  for (const id of LIVE_IDS) els[id] = makeElement(id);

  const store = { local: {}, session: {} };
  const docListeners = {};

  const doc = {
    readyState: "loading",
    location: { protocol: "https:" },
    body: makeElement("body"),
    head: makeElement("head"),
    hidden: false,
    addEventListener(ev, fn){ (docListeners[ev] = docListeners[ev] || []).push(fn); },
    removeEventListener(){},
    getElementById(id){ return els[id] || null; },
    querySelector(sel){
      if (typeof sel === "string" && sel.startsWith("#")) return els[sel.slice(1)] || null;
      return null;
    },
    querySelectorAll(){ return []; },
    createElement(){ return makeElement("tmp"); }
  };

  const area = (bucket) => ({
    get(keys, cb){
      let out = {};
      if (typeof keys === "string") out[keys] = store[bucket][keys];
      else if (Array.isArray(keys)) keys.forEach(k => { out[k] = store[bucket][k]; });
      else if (keys && typeof keys === "object") {
        for (const [k, d] of Object.entries(keys)) out[k] = (k in store[bucket]) ? store[bucket][k] : d;
      } else out = Object.assign({}, store[bucket]);
      if (cb) { cb(out); return; }
      return Promise.resolve(out);
    },
    set(obj, cb){ Object.assign(store[bucket], obj); if (cb){ cb(); return; } return Promise.resolve(); },
    remove(keys, cb){
      (Array.isArray(keys) ? keys : [keys]).forEach(k => delete store[bucket][k]);
      if (cb){ cb(); return; } return Promise.resolve();
    },
    clear(cb){ store[bucket] = {}; if (cb){ cb(); return; } return Promise.resolve(); }
  });

  // Stands in for the service worker + offscreen document.
  const offscreen = { keys: null, vaultKey: null };
  function handleMessage(msg){
    switch (msg && msg.type) {
      case "QTC_STORE_ENCRYPTED": store.local.qtcVault = msg.payload; return { ok: true };
      case "QTC_LOAD_ENCRYPTED":  return { ok: true, payload: store.local.qtcVault || null };
      case "QTC_SESS_OPEN":
        offscreen.keys = msg.keys;
        if (msg.vaultKey) offscreen.vaultKey = msg.vaultKey;
        return { ok: true };
      case "QTC_SESS_QUERY":
        return offscreen.keys
          ? { ok: true, keys: offscreen.keys, vaultKey: offscreen.vaultKey }
          : { ok: false };
      case "QTC_SESS_CLEAR": offscreen.keys = null; offscreen.vaultKey = null; return { ok: true };
      default: return { ok: true };
    }
  }

  const sandbox = {
    crypto: require("crypto").webcrypto,
    console: { log(){}, warn(){}, error(){}, info(){} },
    document: doc,
    navigator: { language: "en-US", userAgent: "node-test", clipboard: { writeText: async () => {} } },
    screen: { height: 1080, width: 1920, colorDepth: 24, availHeight: 1040, availWidth: 1920, pixelDepth: 24 },
    history: { length: 1 },
    location: { protocol: "https:" },
    setTimeout: (fn) => 0, clearTimeout(){}, setInterval: () => 0, clearInterval(){},
    TextEncoder, TextDecoder, btoa, atob, URL,
    AbortSignal: { timeout: () => undefined },
    fetch: async () => ({ ok: true, status: 200, json: async () => [], text: async () => "[]" }),
    chrome: {
      runtime: {
        id: "test", lastError: undefined,
        sendMessage(msg, cb){ const r = handleMessage(msg); if (cb) cb(r); return Promise.resolve(r); },
        onMessage: { addListener(){} }
      },
      storage: { local: area("local"), session: area("session") },
      offscreen: { hasDocument: async () => true, createDocument: async () => {} }
    },
    addEventListener(){}, removeEventListener(){}
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  for (const rel of POPUP_SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), sandbox, { filename: rel });
  }
  return { sandbox, els, store, docListeners, offscreen };
}

async function boot(ctx) {
  ctx.sandbox.document.readyState = "complete";
  for (const fn of (ctx.docListeners["DOMContentLoaded"] || [])) await fn();
}

// Waits on real time, not just microtasks: the click handler kicks off
// createVault() without awaiting it, and deriving the vault key runs 600k
// PBKDF2 iterations, which takes hundreds of milliseconds.
function waitFor(cond, label, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    (function poll() {
      let ok = false;
      try { ok = cond(); } catch (e) { /* keep waiting */ }
      if (ok) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(poll, 10);
    })();
  });
}

const settle = (ms = 400) => new Promise(r => setTimeout(r, ms));

// Runs the real "Create wallet" click handler.
async function createWallet(ctx, password, { expectVault = true } = {}) {
  ctx.els.password.value = password;
  ctx.els.passwordConfirm.value = password;
  ctx.els.passwordConfirmField.style.display = "";
  await ctx.els.createBtn.__fire("click");
  if (expectVault) {
    await waitFor(() => ctx.store.local.qtcVault && ctx.store.local.qtcKeys, "the vault and first key to be written");
    await settle();
  } else {
    // Nothing should appear; give it long enough that a regression would show.
    await settle(1500);
  }
}

/* ------------------------------------------------------------------ */

test("the create-wallet form survives the session-gate poll", async () => {
  // session-gate.js re-evaluates the auth pane every 5 seconds. It used to
  // force setAuthMode('unlock') on every poll, which mid-typing switched the
  // form to Unlock, hid the Create button and wiped the confirmation field --
  // and the subsequent Unlock then reported "Wrong password" against a vault
  // that had never been created.
  const ctx = makeSandbox();
  await boot(ctx);
  await settle(200);

  assert.notStrictEqual(ctx.els.createBtn.style.display, "none",
    "should start on the create form when no vault exists");

  // The user is part-way through typing.
  ctx.els.password.value = "correct horse battery";
  ctx.els.passwordConfirm.value = "correct horse battery";

  // Fire the gate exactly as its interval would, several times over.
  for (let i = 0; i < 3; i++) {
    await ctx.sandbox.QTC_gate();
    await settle(120);
  }

  assert.strictEqual(ctx.els.passwordConfirm.value, "correct horse battery",
    "the poll wiped the confirmation field");
  assert.strictEqual(ctx.els.passwordConfirmField.style.display, "",
    "the poll hid the confirmation field");
  assert.notStrictEqual(ctx.els.createBtn.style.display, "none",
    "the poll hid the Create wallet button");

  // And creation still works afterwards.
  await createWallet(ctx, "correct horse battery");
  assert.ok(ctx.store.local.qtcVault, "wallet creation broke after the poll");
});

test("the gate switches to unlock once a vault does exist", async () => {
  const ctx = makeSandbox();
  await boot(ctx);
  await createWallet(ctx, "correct horse battery");

  // Lock, then let the gate re-evaluate: now there IS a vault, so Unlock is right.
  await ctx.sandbox.clearSession();
  await ctx.sandbox.QTC_gate();
  await settle(200);

  assert.strictEqual(ctx.els.createBtn.style.display, "none",
    "Create should be hidden once a vault exists");
  assert.notStrictEqual(ctx.els.unlockBtn.style.display, "none",
    "Unlock should be offered once a vault exists");
});

test("creating a wallet persists both the vault and the first key", async () => {
  const ctx = makeSandbox();
  await boot(ctx);
  await createWallet(ctx, "correct horse battery");

  assert.ok(ctx.store.local.qtcVault, "no vault was written");
  assert.ok(ctx.store.local.qtcKeys, "the first key was never persisted");
  assert.strictEqual(ctx.sandbox.getKeys().length, 1, "expected exactly one key in memory");
  assert.strictEqual(ctx.store.local.qtcVault.iterations, 600000, "wrong KDF iteration count");
});

test("the generated key is a real, round-trippable keypair", async () => {
  const ctx = makeSandbox();
  await boot(ctx);
  await createWallet(ctx, "correct horse battery");

  const k = ctx.sandbox.getKeys()[0];
  assert.ok(k && k.addr && k.wif, "key is incomplete");
  assert.strictEqual(ctx.sandbox.coinjs.wif2address(k.wif).address, k.addr, "WIF does not derive the address");
  assert.ok(ctx.sandbox.coinjs.addressDecode(k.addr), "address fails checksum validation");
});

test("a weak password is rejected and no vault is created", async () => {
  for (const bad of ["short", "12345678", "aaaaaaaa", "password"]) {
    const ctx = makeSandbox();
    await boot(ctx);
    await createWallet(ctx, bad, { expectVault: false });
    assert.ok(!ctx.store.local.qtcVault, `weak password "${bad}" was accepted`);
  }
});

test("a mismatched confirmation is rejected", async () => {
  const ctx = makeSandbox();
  await boot(ctx);
  ctx.els.password.value = "correct horse battery";
  ctx.els.passwordConfirm.value = "correct horse batteryX";
  ctx.els.passwordConfirmField.style.display = "";
  await ctx.els.createBtn.__fire("click");
  await settle(1500);
  assert.ok(!ctx.store.local.qtcVault, "mismatched confirmation created a vault");
});

test("the vault key reaches the offscreen session so reopens can still persist", async () => {
  // Without this, state.cryptoKey was null after a popup reopen and every
  // address created in a restored session was silently dropped at the next lock.
  const ctx = makeSandbox();
  await boot(ctx);
  await createWallet(ctx, "correct horse battery");
  assert.ok(ctx.offscreen.vaultKey, "no vault key was handed to the offscreen session");
  assert.ok(ctx.offscreen.keys && ctx.offscreen.keys.length === 1, "keys were not synced to the session");
});

test("a restored session can add an address and it survives", async () => {
  const first = makeSandbox();
  await boot(first);
  await createWallet(first, "correct horse battery");
  const storedVault = first.store.local.qtcVault;
  const storedKeys = first.store.local.qtcKeys;
  const session = { keys: first.offscreen.keys, vaultKey: first.offscreen.vaultKey };

  // Reopen the popup: same storage, same live offscreen session, no password.
  const second = makeSandbox();
  second.store.local.qtcVault = storedVault;
  second.store.local.qtcKeys = storedKeys;
  second.offscreen.keys = session.keys;
  second.offscreen.vaultKey = session.vaultKey;
  await boot(second);

  assert.strictEqual(second.sandbox.isUnlocked(), true, "session was not restored");

  const before = second.store.local.qtcKeys.ciphertext;
  const added = await second.sandbox.generateAddress();
  assert.ok(added, "generateAddress failed in a restored session");
  assert.notStrictEqual(second.store.local.qtcKeys.ciphertext, before,
    "the new address was never written to storage -- it would vanish at the next lock");
  assert.strictEqual(second.sandbox.getKeys().length, 2, "expected two keys after adding one");
});

test("unreadable stored keys are never overwritten", async () => {
  // The fund-loss path: a decrypt failure used to leave state.keys empty with
  // no error, and the next write replaced every WIF with that empty list.
  const ctx = makeSandbox();
  await boot(ctx);
  await createWallet(ctx, "correct horse battery");

  const intact = ctx.store.local.qtcKeys;
  // Corrupt the ciphertext the way a partial write or a bad migration would.
  ctx.store.local.qtcKeys = { iv: intact.iv, ciphertext: intact.ciphertext.slice(0, -8) + "AAAAAAAA" };

  await ctx.sandbox.loadKeysEncrypted();
  assert.strictEqual(ctx.sandbox.getKeys().length, 0, "corrupted keys should not load");

  const corrupted = ctx.store.local.qtcKeys.ciphertext;
  await assert.rejects(() => ctx.sandbox.saveKeysEncrypted(), /refusing to overwrite/,
    "a write was allowed over keys that could not be read");
  assert.strictEqual(ctx.store.local.qtcKeys.ciphertext, corrupted,
    "storage was modified despite the guard");

  const gen = await ctx.sandbox.generateAddress();
  assert.strictEqual(gen, null, "generateAddress should refuse while keys are unreadable");
});

run();
