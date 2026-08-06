/*
 * tx-math.js — transaction sizing, coin selection and fee arithmetic.
 *
 * Split out of popup.js so the money math can be tested on its own, without a
 * DOM or a network. See test/transaction.test.js.
 *
 * Everything here works in integer satoshis. v0.3.3 and earlier subtracted QTC
 * floats (`total - amount - fee`) and then called .toFixed(8), so rounding
 * could place the outputs a satoshi above the inputs and the node would reject
 * the transaction.
 */
(function (global) {
  "use strict";

  /*
   * Chain constants, checked against Qubitcoin's own node source
   * (super-quantum/qubitcoin), which is a Bitcoin Core fork that leaves these
   * policy values unchanged:
   *
   *   src/policy/policy.h   DUST_RELAY_TX_FEE        = 3000 sat/kB
   *                         DEFAULT_MIN_RELAY_TX_FEE = 1000 sat/kB  (= 1 sat/byte)
   *
   * Bitcoin Core's GetDustThreshold() for a P2PKH output is
   *   (34 output bytes + 148 spend bytes) * 3000 / 1000 = 546 sat,
   * which is where DUST_LIMIT_SAT comes from. The 1 sat/byte floor enforced in
   * buildAndSignTx() is DEFAULT_MIN_RELAY_TX_FEE expressed per byte.
   *
   * 546 is the P2PKH threshold. Segwit and P2SH outputs have a lower one
   * (294 sat for P2WPKH), so applying 546 uniformly is stricter than the node
   * requires. That errs toward rejecting a send rather than creating an output
   * the network will not relay.
   */
  var SATS_PER_QTC = 1e8;
  var DUST_LIMIT_SAT = 546;
  var MAX_INPUTS = 300;       // keeps the serialized tx well under the 100 kB relay cap
  var OUTPUT_SIZE = 34;       // 8 value + 1 script len + 25 P2PKH script; segwit/P2SH are smaller
  var TX_OVERHEAD = 10;       // 4 version + 1 vin count + 1 vout count + 4 locktime

  function qtcToSat(qtc) {
    var n = Number(qtc);
    if (!isFinite(n) || n < 0) throw new Error("Invalid amount");
    var sat = Math.round(n * SATS_PER_QTC);
    if (!Number.isSafeInteger(sat)) throw new Error("Amount out of range");
    return sat;
  }

  // coinjs's addoutput() takes decimal QTC and re-multiplies by 1e8 internally,
  // so hand it a fixed 8-decimal string that converts back to the exact satoshi.
  function satToQtcString(sat) {
    return (sat / SATS_PER_QTC).toFixed(8);
  }

  /*
   * A P2PKH input is:
   *   32 txid + 4 vout + 1 script length + scriptSig + 4 sequence
   * and scriptSig is:
   *   1 push + signature (<= 72) + 1 push + pubkey
   * giving 115 + pubkey bytes.
   *
   *   compressed pubkey   (33 bytes) -> 148
   *   uncompressed pubkey (65 bytes) -> 180
   *
   * coin.js runs with `coinjs.compressed = false`, so keys are uncompressed and
   * the old hardcoded 148 under-estimated every transaction by ~18%. The fee
   * actually paid therefore fell below the rate the user picked.
   */
  function inputSize(pubkeyBytes) {
    if (!Number.isFinite(pubkeyBytes) || pubkeyBytes <= 0) pubkeyBytes = 65;
    return 115 + pubkeyBytes;
  }

  function estimateVSize(numIn, numOut, perInput) {
    return numIn * perInput + numOut * OUTPUT_SIZE + TX_OVERHEAD;
  }

  /*
   * Pick UTXOs and settle the fee.
   *
   * Largest-first: each extra input adds `perInput` bytes of fee, so taking the
   * big ones first keeps the transaction small. v0.3.3 spent every confirmed
   * UTXO on every send, consolidating the whole wallet each time -- worse
   * privacy and a much larger fee than the transaction needed.
   *
   * Returns { selected, inputSat, feeSat, changeSat, vsize }.
   */
  function planTransaction(opts) {
    var utxos = opts.utxos || [];
    var amountSat = opts.amountSat;
    var feeRate = Number(opts.feeRate);
    var perInput = inputSize(opts.pubkeyBytes);

    if (!Number.isSafeInteger(amountSat) || amountSat <= 0) throw new Error("Invalid amount");
    if (!isFinite(feeRate) || feeRate <= 0) throw new Error("Invalid fee rate");
    if (amountSat < DUST_LIMIT_SAT) {
      throw new Error("Amount is below the dust limit (" + satToQtcString(DUST_LIMIT_SAT) + " QTC)");
    }

    var spendable = utxos.filter(function (u) { return u && Number.isSafeInteger(u.value) && u.value > 0; });
    if (!spendable.length) throw new Error("No spendable outputs");

    var candidates = spendable.slice().sort(function (a, b) { return b.value - a.value; });

    var selected = [];
    var inputSat = 0;
    var feeSat = 0;
    var required = 0;

    for (var i = 0; i < candidates.length; i++) {
      selected.push(candidates[i]);
      inputSat += candidates[i].value;
      feeSat = Math.ceil(estimateVSize(selected.length, 2, perInput) * feeRate);
      required = amountSat + feeSat;
      if (inputSat >= required) break;
      if (selected.length >= MAX_INPUTS) break;
    }

    if (inputSat < required) {
      throw new Error(
        "Insufficient funds: need " + satToQtcString(required) + " QTC (" +
        satToQtcString(amountSat) + " + " + satToQtcString(feeSat) + " fee), have " +
        satToQtcString(inputSat) + " QTC"
      );
    }

    var changeSat = inputSat - amountSat - feeSat;
    if (changeSat < DUST_LIMIT_SAT) {
      // A change output this small costs more to spend than it is worth. Drop
      // it and let the remainder go to the fee (at most DUST-1 + one output's
      // worth of fee, well under a thousand satoshis).
      changeSat = 0;
      feeSat = inputSat - amountSat;
    }

    // Nothing may be created or destroyed.
    if (amountSat + changeSat + feeSat !== inputSat) {
      throw new Error("Internal error: transaction does not balance");
    }

    return {
      selected: selected,
      inputSat: inputSat,
      feeSat: feeSat,
      changeSat: changeSat,
      vsize: estimateVSize(selected.length, changeSat > 0 ? 2 : 1, perInput)
    };
  }

  var api = {
    SATS_PER_QTC: SATS_PER_QTC,
    DUST_LIMIT_SAT: DUST_LIMIT_SAT,
    MAX_INPUTS: MAX_INPUTS,
    qtcToSat: qtcToSat,
    satToQtcString: satToQtcString,
    inputSize: inputSize,
    estimateVSize: estimateVSize,
    planTransaction: planTransaction
  };

  global.QtcTx = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
