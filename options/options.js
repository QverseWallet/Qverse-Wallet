/*
 * Read-only settings view.
 *
 * Until v0.3.3 this page offered editable Broadcast / Esplora URL fields and a
 * Save button. The values were persisted to chrome.storage.local under
 * qtcBroadcastUrl / qtcBalanceUrl, but background/service-worker.js has always
 * used hardcoded constants and never read them back, so saving did nothing
 * while telling the user it had worked.
 *
 * Rather than wire the setting up, the fields are now read-only: a
 * user-supplied broadcast endpoint would receive signed transactions, and the
 * reachable hosts are pinned in manifest.json anyway.
 */
"use strict";

const $ = (s) => document.querySelector(s);

// Mirrors background/service-worker.js and popup/popup.js. Keep in sync.
const ENDPOINTS = {
  broadcast: "https://explorer-api.superquantum.io/tx",
  address:   "https://explorer-api.superquantum.io/address/{address}",
  price:     "https://api.coinex.com/v2/spot/ticker?market=QTCUSDT"
};

const AUTOLOCK_LABELS = {
  0: "Never",
  300000: "5 minutes",
  900000: "15 minutes",
  1800000: "30 minutes",
  3600000: "1 hour"
};

function describeAutolock(ttl){
  if (AUTOLOCK_LABELS[ttl]) return AUTOLOCK_LABELS[ttl];
  if (typeof ttl === "number" && ttl > 0) return Math.round(ttl / 60000) + " minutes";
  return "15 minutes (default)";
}

// Drops any key material left in storage.session by <= v0.3.3, which stored the
// AES key in the same object as the ciphertext it was meant to protect. The
// popup does this too; doing it here covers the case where the options page is
// opened without the popup.
async function purgeLegacySessionBlobs(){
  try {
    await chrome.storage.session.remove(['qtcSession', 'qtcSessionEnv', 'qtcTempKeysEnc']);
  } catch (e) { /* storage.session may be unavailable; nothing to clean up */ }
}

async function load(){
  $("#qtcBroadcastUrl").value = ENDPOINTS.broadcast;
  $("#qtcBalanceUrl").value   = ENDPOINTS.address;
  $("#qtcPriceUrl").value     = ENDPOINTS.price;

  try {
    const cfg = await chrome.storage.local.get({ qtcAutolockTTL: 900000 });
    $("#autolockCurrent").value = describeAutolock(cfg.qtcAutolockTTL);
  } catch (e) {
    $("#autolockCurrent").value = "unavailable";
  }

  // Remove the dead settings this page used to write, so they stop lingering.
  try { await chrome.storage.local.remove(['qtcBroadcastUrl', 'qtcBalanceUrl']); } catch (e) {}
  await purgeLegacySessionBlobs();
}

document.addEventListener("DOMContentLoaded", load);
