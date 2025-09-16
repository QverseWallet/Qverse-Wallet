(function(){
  function $id(x){ return document.getElementById(x); }
  function send(msg){ return new Promise(res => chrome.runtime.sendMessage(msg, res)); }
  function query(){ return send({type:'QTC_SESS_QUERY'}); }
  function open(keys){ return send({type:'QTC_SESS_OPEN', keys}); }
  function touch(){ return send({type:'QTC_SESS_TOUCH'}); }

  function startKeepAlive(){
    ['click','keydown','mousemove'].forEach(ev => document.addEventListener(ev, ()=>touch(), {passive:true}));
    setInterval(()=>touch(), 20000);
  }

  document.addEventListener('DOMContentLoaded', async ()=>{
    try{
      const r = await query();
      if (r && r.ok && Array.isArray(r.keys)){
        if (window.state){ state.keys = r.keys; state.unlocked = true; }
        if (typeof setVisible==='function'){ setVisible('#authSection', false); setVisible('#walletSection', true); }
        if (typeof detectCoinjs==='function') detectCoinjs();
        if (typeof renderKeys==='function') renderKeys();
        if (typeof fetchBalances==='function') fetchBalances();
        startKeepAlive();
      }
    }catch{}

    const ws = $id('walletSection');
    if (ws){
      const mo = new MutationObserver(async ()=>{
        const visible = ws.style && ws.style.display !== 'none';
        if (visible && window.state && Array.isArray(state.keys) && state.keys.length){
          await open(state.keys);
          startKeepAlive();
        }
      });
      mo.observe(ws, { attributes:true, attributeFilter:['style','class'] });
    }
  });
})();

(function(){
  function $id(x){ return document.getElementById(x); }
  const send = (m)=> new Promise(res => chrome.runtime.sendMessage(m, res));
  const query = ()=> send({type:'QTC_SESS_QUERY'});
  const open  = (k)=> send({type:'QTC_SESS_OPEN', keys:k});
  const touch = ()=> send({type:'QTC_SESS_TOUCH'});
  function startKA(){ ['click','keydown','mousemove'].forEach(ev => document.addEventListener(ev, ()=>touch(), {passive:true})); setInterval(()=>touch(), 20000); }
  async function tryOpenFromState(){
    try{
      if (window.__qtcSessOpened) return;
      if (window.state && Array.isArray(state.keys) && state.keys.length){
        const r = await open(state.keys);
        if (r && r.ok){ window.__qtcSessOpened = true; startKA(); }
      }
    }catch{}
  }
  document.addEventListener('DOMContentLoaded', async ()=>{
    try{ const r = await query(); if (r && r.ok && Array.isArray(r.keys)){ if (window.state){ state.keys=r.keys; state.unlocked=true; } if (typeof setVisible==='function'){ setVisible('#authSection', false); setVisible('#walletSection', true); } if (typeof detectCoinjs==='function') detectCoinjs(); if (typeof renderKeys==='function') renderKeys(); if (typeof fetchBalances==='function') fetchBalances(); startKA(); } }catch{}
    const ws = $id('walletSection');
    if (ws){
      const mo = new MutationObserver(async ()=>{
        const visible = ws.style && ws.style.display !== 'none';
        if (visible) await tryOpenFromState();
      });
      mo.observe(ws, { attributes:true, attributeFilter:['style','class'] });
    }
    let t0=Date.now(), iv=setInterval(()=>{ if (Date.now()-t0>60000){ clearInterval(iv); return; } tryOpenFromState(); }, 1000);
  });
})();