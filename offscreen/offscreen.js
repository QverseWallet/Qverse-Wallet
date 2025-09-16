// Offscreen session memory (10 min TTL), no disk writes
(() => {
  const S = { keys:null, expiresAt:0, timer:null };

  function clearSess(){ S.keys=null; S.expiresAt=0; if(S.timer){ clearInterval(S.timer); S.timer=null; } }
  function touch(){ if(!S.keys) return; S.expiresAt = Date.now() + 10*60*1000; }
  function ensureTimer(){
    if (S.timer) return;
    S.timer = setInterval(()=>{ if (S.keys && Date.now()>S.expiresAt) clearSess(); }, 5000);
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
  });

  chrome.runtime.sendMessage({ type:'QTC_SESS_OFFSCREEN_READY' });
})();
