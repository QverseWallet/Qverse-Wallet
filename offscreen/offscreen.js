// Offscreen session memory (configurable TTL), no disk writes
(() => {
  const DEFAULT_TTL = 900000; // 15 min default
  const S = { keys:null, expiresAt:0, timer:null, ttl: DEFAULT_TTL };

  function clearSess(){ S.keys=null; S.expiresAt=0; if(S.timer){ clearInterval(S.timer); S.timer=null; } }
  function touch(){ 
    if(!S.keys) return; 
    // ttl=0 means never expire
    if(S.ttl === 0){
      S.expiresAt = Number.MAX_SAFE_INTEGER;
    } else {
      S.expiresAt = Date.now() + S.ttl; 
    }
  }
  function ensureTimer(){
    if (S.timer) return;
    S.timer = setInterval(()=>{ 
      // Skip expiry check if ttl is 0 (never)
      if(S.ttl === 0) return;
      if (S.keys && Date.now()>S.expiresAt) clearSess(); 
    }, 5000);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender && sender.id !== chrome.runtime.id) { return; }
    if (!msg || !msg.type || !msg.type.startsWith('QTC_SESS_')) return;
    if (msg.type==='QTC_SESS_OPEN'){
      S.keys = Array.isArray(msg.keys) ? msg.keys : null;
      touch(); ensureTimer();
      sendResponse({ ok: !!S.keys, expiresAt: S.expiresAt });
      return true;
    }
    if (msg.type==='QTC_SESS_QUERY'){
      if (S.keys && Date.now()<=S.expiresAt){
        sendResponse({ ok:true, keys:S.keys, expiresAt:S.expiresAt });
      } else {
        sendResponse({ ok:false });
      }
      return true;
    }
    if (msg.type==='QTC_SESS_TOUCH'){
      touch(); ensureTimer();
      sendResponse({ ok: !!S.keys, expiresAt:S.expiresAt });
      return true;
    }
    if (msg.type==='QTC_SESS_CLEAR'){
      clearSess(); sendResponse({ ok:true }); return true;
    }
    if (msg.type==='QTC_SESS_SET_TTL'){
      const newTtl = typeof msg.ttl === 'number' ? msg.ttl : DEFAULT_TTL;
      S.ttl = newTtl;
      // Update expiry with new TTL if session is active
      if(S.keys) touch();
      sendResponse({ ok:true, ttl: S.ttl }); 
      return true;
    }
  });

  chrome.runtime.sendMessage({ type:'QTC_SESS_OFFSCREEN_READY' }, () => {
    if (chrome.runtime.lastError) { /* ignore */ }
  });
})();
