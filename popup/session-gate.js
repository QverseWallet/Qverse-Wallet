(function(){
  const send  = (m)=> new Promise(res => chrome.runtime.sendMessage(m, res));
  const query = ()=> send({type:'QTC_SESS_QUERY'});
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
    try{ detectCoinjs?.(); }catch{}
    try{ renderKeys?.(); }catch{}
    try{ fetchBalances?.(); }catch{}
  }
  async function gate(){
    try{ window.QTC_gate = gate; }catch(_){ }

    try{
      const r = await query();
      if (r && r.ok) showWallet(); else showAuth();
    }catch{ showAuth(); }
  }
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', gate);
  } else {
    gate();
  }
  try{
    document.addEventListener('visibilitychange', ()=>{ if (!document.hidden) gate(); });
    window.addEventListener('focus', ()=> gate());
    setInterval(()=>{
      try{
        const a = document.getElementById('authSection');
        const w = document.getElementById('walletSection');
        const aHidden = !a || getComputedStyle(a).display==='none';
        const wHidden = !w || getComputedStyle(w).display==='none';
        if (aHidden && wHidden) gate();
      }catch(_){ gate(); }
    }, 3000);
  }catch(_){}
})();
