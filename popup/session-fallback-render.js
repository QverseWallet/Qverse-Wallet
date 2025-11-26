(function(){
  const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
  function hasKeys(){ try{ return window.state && state.unlocked && Array.isArray(state.keys) && state.keys.length>0; }catch(e){ return false; } }
  function list(){ return document.getElementById('addrList'); }
  function fmt(n){ try{ if (typeof formatQtc==='function') return formatQtc(n); }catch{}; const x=Number(n)||0; return x.toFixed(8); }

  function template(keys){
    return keys.map((k,i)=>`
  <div class="account-row flex items-center justify-between" data-idx="${i}">
    <div class="truncate">
      <div class="flex items-center gap-2">
        <span class="copyIcon copyAddr" title="Copy" data-addr="${k.addr}" aria-label="Copy">📋</span>
        <div class="font-mono truncate">${k.addr}</div>
      </div>
      <div class="text-xs opacity-70">idx ${i}</div>
    </div>
    <div class="flex items-center gap-3">
      <div class="addrBalance font-mono text-sm" data-addr="${k.addr}">${fmt(k.balance || 0)}</div>
      <button class="btn btn-xs" data-action="export-wif" data-idx="${i}">WIF</button>
    </div>
  </div>`).join("");
  }

  async function ensure(){
    const t0 = Date.now();
    // wait up to 2s for DOM and keys
    while(Date.now()-t0<2000){
      if(list() && hasKeys()) break;
      await new Promise(r=>setTimeout(r,40));
    }
    const ul = list();
    if (!ul || !hasKeys()) return;
    if (ul.childElementCount>0) return; // already painted by core

    // Paint using the same markup core uses
    try{
      ul.innerHTML = template(state.keys);
      // also seed "receive" card like core does
      const last = state.keys[state.keys.length-1];
      const recv = document.getElementById('receiveAddr');
      if (recv){
        recv.innerHTML = last ? `<div class="card"><b>${last.addr}</b></div>` : "";
      }
      // After paint, trigger balances refresh if available
      try{ if (typeof fetchBalances==='function') fetchBalances(); }catch{}
    }catch(e){ /* silent */ }
  }

  function init(){
    ensure();
    // refresh in these events as a safeguard
    ['visibilitychange','focus'].forEach(ev => document.addEventListener(ev, ensure, {passive:true}));
  }

  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();