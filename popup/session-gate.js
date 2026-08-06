// Keeps the popup's auth/wallet visibility in sync with the offscreen session
// and enforces auto-lock while the popup stays open.
//
// Up to v0.3.3 this logic existed three times over — session-gate.js,
// session-bridge.js and session-fallback-render.js each polled on their own
// interval (3s / 300ms / 40ms) and wrote to the same DOM nodes, which is what
// produced the flicker between the auth and wallet panes. This is the only
// copy left; restoring the session itself is popup.js's job.
(function(){
  const send = (m) => new Promise(res => {
    try {
      chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r); });
    } catch(e){ res(null); }
  });

  function showAuth(){
    document.body.classList.add('auth-mode');
    const a = document.getElementById('authSection');
    const w = document.getElementById('walletSection');
    if (a){ a.classList.remove('hidden'); a.style.display = ''; }
    if (w){ w.classList.add('hidden');    w.style.display = 'none'; }
    // Ask popup.js which mode applies instead of assuming 'unlock'. Hardcoding
    // it here flipped the create-wallet form to Unlock on the 5s poll while a
    // first-time user was still typing their password.
    try { window.refreshAuthMode && window.refreshAuthMode(); } catch(_){}
  }

  function showWallet(){
    document.body.classList.remove('auth-mode');
    const a = document.getElementById('authSection');
    const w = document.getElementById('walletSection');
    if (a){ a.classList.add('hidden');    a.style.display = 'none'; }
    if (w){ w.classList.remove('hidden'); w.style.display = ''; }
  }

  const unlocked = () => { try { return !!(window.isUnlocked && window.isUnlocked()); } catch(_){ return false; } };

  // A single failed query can just mean the offscreen document is still
  // spinning up, so require two in a row before tearing down a live session.
  let misses = 0;

  async function gate(){
    const r = await send({ type: 'QTC_SESS_QUERY' });

    if (r && r.ok){
      misses = 0;
      if (unlocked()) showWallet();
      return;
    }

    if (unlocked()){
      if (++misses < 2) return;
      // Session expired or was cleared elsewhere: drop the in-memory keys too,
      // otherwise auto-lock would hide the UI while leaving the WIFs loaded.
      try { window.clearSession && await window.clearSession(); } catch(_){}
    }
    misses = 0;
    showAuth();
  }

  window.QTC_gate = gate;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', gate);
  else gate();

  document.addEventListener('visibilitychange', ()=>{ if (!document.hidden) gate(); });
  window.addEventListener('focus', gate);
  setInterval(gate, 5000);
})();
