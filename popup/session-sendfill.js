(function(){
  const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
  function readyKeys(){ try{ return state && state.unlocked && Array.isArray(state.keys) && state.keys.length>0; }catch(e){ return false; } }
  function fill(){
    try{
      const sel = document.querySelector('#easyFrom');
      if(!sel) return;
      if(!readyKeys()) return;
      const html = (state.keys||[]).map((k,i)=>`<option value="${i}">${k.addr} (idx ${i})</option>`).join("");
      if (sel.innerHTML !== html) sel.innerHTML = html;
    }catch(e){/* noop */}
  }
  function init(){
    fill();
    setTimeout(fill, 60);
    setTimeout(fill, 160);
    document.addEventListener('click', (ev)=>{
      const tab = ev.target.closest?.('.tab[data-tab="send"]');
      if(tab) setTimeout(fill, 0);
    }, {passive:true});
    ['visibilitychange','focus'].forEach(ev => document.addEventListener(ev, fill, {passive:true}));
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();