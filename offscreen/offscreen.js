// Offscreen session store.
//
// This document is the ONLY place unlocked key material lives while the wallet
// is open. Nothing here is written to disk or to chrome.storage: if the
// document is torn down the session is gone and the password is required
// again, which is the intended fail-closed behaviour.
//
// It also holds the raw vault key so that a reopened popup can persist new
// addresses. That key protects the very WIFs stored beside it, so keeping both
// in the same in-memory store adds no exposure.
(() => {
  const DEFAULT_TTL = 900000; // 15 min, matches popup/index.html's default

  const S = { keys: null, vaultKey: null, expiresAt: 0, timer: null, ttl: DEFAULT_TTL };

  function clearSess(){
    S.keys = null;
    S.vaultKey = null;
    S.expiresAt = 0;
    if (S.timer){ clearInterval(S.timer); S.timer = null; }
  }

  function touch(){
    if (!S.keys) return;
    // ttl === 0 means "never expire"
    S.expiresAt = (S.ttl === 0) ? Number.MAX_SAFE_INTEGER : (Date.now() + S.ttl);
  }

  function ensureTimer(){
    if (S.timer) return;
    S.timer = setInterval(() => {
      if (S.ttl === 0) return;
      if (S.keys && Date.now() > S.expiresAt) clearSess();
    }, 5000);
  }

  function isLive(){
    return !!S.keys && Date.now() <= S.expiresAt;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender && sender.id !== chrome.runtime.id) { return; }
    if (!msg || !msg.type || !msg.type.startsWith('QTC_SESS_')) return;

    if (msg.type === 'QTC_SESS_OPEN'){
      S.keys = Array.isArray(msg.keys) ? msg.keys : null;
      // Only overwrite the cached vault key when the caller supplies one, so a
      // relayed duplicate of this message cannot blank it out.
      if (typeof msg.vaultKey === 'string' && msg.vaultKey) S.vaultKey = msg.vaultKey;
      touch(); ensureTimer();
      sendResponse({ ok: !!S.keys, expiresAt: S.expiresAt });
      return true;
    }

    if (msg.type === 'QTC_SESS_QUERY'){
      if (isLive()){
        sendResponse({ ok: true, keys: S.keys, vaultKey: S.vaultKey, expiresAt: S.expiresAt });
      } else {
        // Expired but not yet swept by the timer: drop it now.
        if (S.keys) clearSess();
        sendResponse({ ok: false });
      }
      return true;
    }

    if (msg.type === 'QTC_SESS_TOUCH'){
      // Never resurrect an already-expired session.
      if (!isLive() && S.keys) clearSess();
      touch(); ensureTimer();
      sendResponse({ ok: !!S.keys, expiresAt: S.expiresAt });
      return true;
    }

    if (msg.type === 'QTC_SESS_CLEAR'){
      clearSess();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'QTC_SESS_SET_TTL'){
      S.ttl = (typeof msg.ttl === 'number' && msg.ttl >= 0) ? msg.ttl : DEFAULT_TTL;
      if (S.keys) touch();
      sendResponse({ ok: true, ttl: S.ttl });
      return true;
    }
  });

  chrome.runtime.sendMessage({ type: 'QTC_SESS_OFFSCREEN_READY' }, () => {
    void chrome.runtime.lastError;
  });
})();
