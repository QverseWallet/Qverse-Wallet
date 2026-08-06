/*
 * Tests for popup/tx-math.js — the money arithmetic, coin selection and fee
 * sizing that decide how much of a user's balance leaves the wallet.
 *
 * Run with:  node test/transaction.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
const { loadWallet, makeRunner, SCRIPTS, ROOT, vm } = require("./load-wallet");
const fs = require("fs");

const QtcTx = require(path.join(ROOT, "popup", "tx-math.js"));
const { test, run } = makeRunner();

const DUST = QtcTx.DUST_LIMIT_SAT;

// A deterministic PRNG so a failing fuzz case can be reproduced from the seed.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---- unit conversion ----------------------------------------------------- */

test("qtcToSat converts the awkward floats exactly", () => {
  const cases = [
    ["0.00000001", 1], ["0.1", 10000000], ["0.07", 7000000],
    ["1.1", 110000000], ["0.29", 29000000], ["2.675", 267500000],
    ["100", 10000000000], ["0.00000546", 546]
  ];
  for (const [qtc, sat] of cases) {
    assert.strictEqual(QtcTx.qtcToSat(qtc), sat, `qtcToSat(${qtc})`);
  }
});

test("satToQtcString round-trips through qtcToSat", () => {
  const rand = mulberry32(7);
  for (let i = 0; i < 5000; i++) {
    const sat = Math.floor(rand() * 1e12) + 1;
    assert.strictEqual(QtcTx.qtcToSat(QtcTx.satToQtcString(sat)), sat, `round-trip at ${sat}`);
  }
});

test("qtcToSat rejects negative and non-finite amounts", () => {
  for (const bad of [-1, NaN, Infinity, "abc"]) {
    assert.throws(() => QtcTx.qtcToSat(bad), /Invalid amount/, `should reject ${bad}`);
  }
});

/* ---- sizing -------------------------------------------------------------- */

test("input size matches the known P2PKH figures", () => {
  assert.strictEqual(QtcTx.inputSize(33), 148, "compressed pubkey input");
  assert.strictEqual(QtcTx.inputSize(65), 180, "uncompressed pubkey input");
});

test("uncompressed keys are charged more than the old hardcoded 148", () => {
  // v0.3.3 used `148*nIn + 34*nOut + 10` regardless of key compression, but
  // coinjs generates uncompressed keys, so every fee was ~18% short.
  const nIn = 3, nOut = 2;
  const legacy = 148 * nIn + 34 * nOut + 10;
  const corrected = QtcTx.estimateVSize(nIn, nOut, QtcTx.inputSize(65));
  assert.ok(corrected > legacy, "corrected estimate must exceed the legacy one");
  assert.strictEqual(corrected - legacy, 32 * nIn, "difference should be 32 bytes per input");
});

/* ---- coin selection ------------------------------------------------------ */

const utxo = (value, i) => ({ txid: String(i).padStart(64, "0"), vout: 0, value });

test("selects the fewest inputs by taking the largest first", () => {
  const utxos = [utxo(1000, 1), utxo(500000, 2), utxo(2000, 3), utxo(300000, 4)];
  const plan = QtcTx.planTransaction({ utxos, amountSat: 400000, feeRate: 5, pubkeyBytes: 65 });
  assert.strictEqual(plan.selected.length, 1, "one big UTXO should be enough");
  assert.strictEqual(plan.selected[0].value, 500000);
});

test("does not spend the whole wallet on a small payment", () => {
  // v0.3.3 consumed every confirmed UTXO on every send.
  const utxos = Array.from({ length: 50 }, (_, i) => utxo(100000, i));
  const plan = QtcTx.planTransaction({ utxos, amountSat: 50000, feeRate: 5, pubkeyBytes: 65 });
  assert.strictEqual(plan.selected.length, 1, `used ${plan.selected.length} inputs for one small payment`);
});

test("pulls in more inputs when one is not enough", () => {
  const utxos = [utxo(30000, 1), utxo(30000, 2), utxo(30000, 3), utxo(30000, 4)];
  const plan = QtcTx.planTransaction({ utxos, amountSat: 100000, feeRate: 2, pubkeyBytes: 65 });
  assert.strictEqual(plan.selected.length, 4);
  assert.strictEqual(plan.inputSat, 120000);
});

/* ---- fee and change correctness ------------------------------------------ */

test("the fee always covers the transaction's real size", () => {
  const rand = mulberry32(99);
  for (let i = 0; i < 2000; i++) {
    const pubkeyBytes = rand() < 0.5 ? 33 : 65;
    const feeRate = 1 + Math.floor(rand() * 50);
    const utxos = Array.from({ length: 1 + Math.floor(rand() * 8) },
      (_, j) => utxo(DUST + Math.floor(rand() * 5_000_000), j));
    const total = utxos.reduce((a, u) => a + u.value, 0);
    const amountSat = DUST + Math.floor(rand() * Math.max(1, total / 2));

    let plan;
    try { plan = QtcTx.planTransaction({ utxos, amountSat, feeRate, pubkeyBytes }); }
    catch (e) { continue; } // insufficient funds is a legitimate outcome
    const size = QtcTx.estimateVSize(plan.selected.length, plan.changeSat > 0 ? 2 : 1,
                                     QtcTx.inputSize(pubkeyBytes));
    assert.ok(plan.feeSat >= size * feeRate,
      `fee ${plan.feeSat} under ${size * feeRate} (${plan.selected.length} in, rate ${feeRate})`);
  }
});

test("inputs, outputs and fee always balance exactly", () => {
  const rand = mulberry32(1234);
  let checked = 0;
  for (let i = 0; i < 4000; i++) {
    const utxos = Array.from({ length: 1 + Math.floor(rand() * 6) },
      (_, j) => utxo(1000 + Math.floor(rand() * 10_000_000), j));
    const total = utxos.reduce((a, u) => a + u.value, 0);
    const amountSat = DUST + Math.floor(rand() * total);
    let plan;
    try {
      plan = QtcTx.planTransaction({
        utxos, amountSat, feeRate: 1 + Math.floor(rand() * 20), pubkeyBytes: 65
      });
    } catch (e) { continue; }

    assert.strictEqual(amountSat + plan.changeSat + plan.feeSat, plan.inputSat,
      "amount + change + fee must equal the inputs");
    assert.ok(plan.changeSat === 0 || plan.changeSat >= DUST, "change must be zero or above dust");
    assert.ok(plan.feeSat > 0, "fee must be positive");
    checked++;
  }
  assert.ok(checked > 500, `only ${checked} cases actually planned`);
});

test("dust-sized change is absorbed into the fee, never emitted", () => {
  // Pick an amount that leaves a few hundred satoshis after the fee.
  const perInput = QtcTx.inputSize(65);
  const feeRate = 3;
  const feeFor2 = Math.ceil(QtcTx.estimateVSize(1, 2, perInput) * feeRate);
  const inputVal = 1_000_000;
  const amountSat = inputVal - feeFor2 - 100; // leaves 100 sat of change: dust

  const plan = QtcTx.planTransaction({
    utxos: [utxo(inputVal, 1)], amountSat, feeRate, pubkeyBytes: 65
  });
  assert.strictEqual(plan.changeSat, 0, "dust change must not become an output");
  assert.strictEqual(plan.feeSat, inputVal - amountSat, "the remainder must go to the fee");
  assert.ok(plan.feeSat - feeFor2 < DUST, "absorbed amount should be under the dust limit");
});

/* ---- rejections ---------------------------------------------------------- */

test("rejects amounts below the dust limit", () => {
  assert.throws(
    () => QtcTx.planTransaction({ utxos: [utxo(1e6, 1)], amountSat: DUST - 1, feeRate: 5, pubkeyBytes: 65 }),
    /dust limit/
  );
});

test("rejects an unaffordable amount instead of underpaying the fee", () => {
  assert.throws(
    () => QtcTx.planTransaction({ utxos: [utxo(100000, 1)], amountSat: 99999, feeRate: 10, pubkeyBytes: 65 }),
    /Insufficient funds/
  );
});

test("rejects invalid fee rates", () => {
  for (const rate of [0, -1, NaN]) {
    assert.throws(
      () => QtcTx.planTransaction({ utxos: [utxo(1e6, 1)], amountSat: 1e5, feeRate: rate, pubkeyBytes: 65 }),
      /Invalid fee rate/, `should reject rate ${rate}`
    );
  }
});

/* ---- the estimate against a real signed transaction ---------------------- */

test("estimated size bounds the real serialized transaction", () => {
  const w = loadWallet();
  const key = w.coinjs.newKeys();
  const pubkeyBytes = w.coinjs.wif2pubkey(key.wif).pubkey.length / 2;

  for (const nIn of [1, 2, 5]) {
    const tx = w.coinjs.transaction();
    tx.version = 2;
    for (let i = 0; i < nIn; i++) {
      tx.addinput("aa".repeat(32), i, "", 0xffffffff);
    }
    tx.addoutput(key.address, "0.01000000");
    tx.addoutput(key.address, "0.02000000");

    // Same signing routine popup.js uses.
    const txu = w.coinjs.transaction().deserialize(tx.serialize());
    txu.version = 2;
    for (let i = 0; i < txu.ins.length; i++) {
      const tmpu = w.coinjs.transaction().deserialize(txu.serialize());
      for (let j = 0; j < tmpu.ins.length; j++) tmpu.ins[j].script = w.coinjs.script();
      tmpu.ins[i].script = w.coinjs.script().spendToScript(key.address);
      const sighex = tmpu.transactionSig(i, key.wif, 1);
      const sc = w.coinjs.script();
      sc.writeBytes(w.Crypto.util.hexToBytes(sighex));
      sc.writeBytes(w.Crypto.util.hexToBytes(w.coinjs.wif2pubkey(key.wif).pubkey));
      txu.ins[i].script = sc;
    }

    const actualBytes = txu.serialize().length / 2;
    const estimate = QtcTx.estimateVSize(nIn, 2, QtcTx.inputSize(pubkeyBytes));

    assert.ok(estimate >= actualBytes,
      `${nIn} inputs: estimate ${estimate} under real size ${actualBytes} -- fee would be short`);
    // The estimate assumes a worst-case 72-byte signature; allow a few bytes of
    // slack per input but not an order of magnitude.
    assert.ok(estimate - actualBytes <= 3 * nIn + 2,
      `${nIn} inputs: estimate ${estimate} overshoots real size ${actualBytes} by too much`);

    // The old formula, for contrast, must be shown to under-pay.
    const legacy = 148 * nIn + 34 * 2 + 10;
    assert.ok(legacy < actualBytes,
      `${nIn} inputs: the legacy 148-byte estimate (${legacy}) should be below the real ${actualBytes}`);
  }
});

run();
