(function(){
  const send  = (m)=> new Promise(res => chrome.runtime.sendMessage(m, res));
  const query = ()=> send({type:'QTC_SESS_QUERY'});
  const open  = (k)=> send({type:'QTC_SESS_OPEN', keys:k});
  const touch = ()=> send({type:'QTC_SESS_TOUCH'});

  function showAuth(){
    document.body.classList.add('auth-mode');
    const a = document.getElementById('authSection');
    const w = document.getElementById('walletSection');
    try { setVisible?.('#authSection', true); setVisible?.('#walletSection', false); } catch {}
    if (a){ a.classList.remove('hidden'); a.style.display=''; }
    if (w){ w.classList.add('hidden');   w.style.display='none'; }
  }
  function showWallet(){
    document.body.classList.remove('auth-mode');
    const a = document.getElementById('authSection');
    const w = document.getElementById('walletSection');
    try { setVisible?.('#authSection', false); setVisible?.('#walletSection', true); } catch {}
    if (a){ a.classList.add('hidden');   a.style.display='none'; }
    if (w){ w.classList.remove('hidden'); w.style.display=''; }
  }
  function renderAll(){
    try{ detectCoinjs?.(); }catch{}
    try{ renderKeys?.(); }catch{}
    try{ fetchBalances?.(); }catch{}
  }
  function startKeepAlive(){
    ['click','keydown','mousemove'].forEach(ev => 
      document.addEventListener(ev, ()=>touch(), {passive:true})
    );
    setInterval(()=>touch(), 20000);
  }

  async function restoreFromSession(){
    try{
      const r = await query();
      if (r && r.ok && Array.isArray(r.keys)){
        try{
          if (window.state){ state.keys = r.keys; state.unlocked = true; }
        }catch{}
        showWallet();
        renderAll();
        try{ await open(r.keys); }catch{}
        startKeepAlive();
        window.__qtcSessOpened = true;
        return true;
      } else {
        return false;
      }
    }catch{ return false; }
  }

 
  let applied = false;
  function checkUnlocked(){
    try{
      if (!applied && window.state && state.unlocked && Array.isArray(state.keys) && state.keys.length){
        applied = true;
        (async()=>{
          try{ await open(state.keys); }catch{}
          showWallet();
          renderAll();
          startKeepAlive();
        })();
      }
    }catch{}
  }

  function init(){
    // Try immediate restore
    restoreFromSession().then(ok => {
      if (!ok) showAuth();
    });
    // Poll for unlock change for a short while (10s)
    const t0 = Date.now();
    const iv = setInterval(()=>{
      if (Date.now() - t0 > 10000){ clearInterval(iv); return; }
      checkUnlocked();
    }, 300);
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();