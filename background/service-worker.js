
// === QTC Offscreen readiness gate ===
let __qtcOffscreenReady = false;
let __qtcWaiters = [];
function __qtcWaitOffscreenReady(timeoutMs=1500){
  return new Promise(async (resolve)=>{
    if (__qtcOffscreenReady){ resolve(true); return; }
    const t = setTimeout(()=>resolve(false), timeoutMs);
    __qtcWaiters.push(()=>{ clearTimeout(t); resolve(true); });
  });
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender && sender.id !== chrome.runtime.id) { return false; }
  if (msg && msg.type === 'QTC_SESS_OFFSCREEN_READY'){
    __qtcOffscreenReady = true;
    const w = __qtcWaiters.slice(); __qtcWaiters.length = 0;
    w.forEach(fn => { try{ fn(); }catch{} });
    return false;
  }
  return false;
});
async function __qtcEnsureOffscreenReady(){
  try{
    const has = await chrome.offscreen.hasDocument();
    if (!has){
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['IFRAME_SCRIPTING'],
        justification: 'Keep in-memory unlock session for QTC wallet (10 min TTL)'
      });
    }
  }catch(e){ /* ignore */ }
  await __qtcWaitOffscreenReady(2000);
}
// === end readiness gate ===

// Service worker loaded
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.type === 'QTC_STORE_ENCRYPTED') {
        await chrome.storage.local.set({ qtcVault: msg.payload });
        sendResponse({ ok: true });
        return;
      }
      if (msg && msg.type === 'QTC_LOAD_ENCRYPTED') {
        const st = await chrome.storage.local.get({ qtcVault: null });
        sendResponse({ ok: true, payload: st.qtcVault });
        return;
      }
      if (msg && msg.type === 'QTC_BROADCAST') {
        const isValidHexRaw = (h) => {
          return (typeof h === 'string') && (h.length % 2 === 0) && (h.length >= 200) && /^[0-9a-fA-F]+$/.test(h);
        };
        if (!isValidHexRaw(msg.rawtx)) {
          sendResponse({ ok:false, status:400, body:'invalid-rawtx' });
          return;
        }

        const BROADCAST_URL = 'https://explorer-api.superquantum.io/tx';
        const res = await fetch(BROADCAST_URL, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: msg.rawtx });
        const body = await res.text();
        sendResponse({ ok: res.ok, status: res.status, body });
        return;
      }
      if (msg && msg.type === 'QTC_GET_BALANCES') {
        const BALANCE_URL = 'https://explorer-api.superquantum.io/address/{address}';
        
        const addrs = Array.isArray(msg.addresses) ? msg.addresses : [];
        const results = {};
        for (const a of addrs) {
          try {
            const url = BALANCE_URL.replace('{address}', encodeURIComponent(a));
            const r = await fetch(url);
            const t = await r.text();
            let parsed = null;
            try {
              const j = JSON.parse(t);
              if (j) {
                const chain = (j.chain_stats || {});
                const mem = (j.mempool_stats || {});
                const funded = (chain.funded_txo_sum || 0) + (mem.funded_txo_sum || 0);
                const spent  = (chain.spent_txo_sum  || 0) + (mem.spent_txo_sum  || 0);
                parsed = { balance: funded - spent };
              }
            } catch (e) {}
            results[a] = { raw: t, parsed };
          } catch (e) {
            results[a] = { raw: String(e), parsed: null };
          }
        }
        sendResponse({ ok: true, results });
        return;
      }
      
      // QTC_SESS_* relay to offscreen (readiness + recursion guard)
      if (msg && msg.type && msg.type.startsWith('QTC_SESS_')) {
        if (msg.__viaSW) { return; }
        await __qtcEnsureOffscreenReady();
        const fwd = Object.assign({}, msg, { __viaSW: true });
        chrome.runtime.sendMessage(fwd, (resp) => {
          try { sendResponse(resp); } catch(e) { try{ sendResponse({ok:false, error:'relay failed'});}catch{} }
        });
        return true;
      }

      sendResponse({ ok: false, error: 'Unrecognized message' });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});
