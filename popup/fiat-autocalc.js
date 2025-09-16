
// Lightweight, non-invasive USD calculator: (price from widget) * (total balance)
(function(){
  function $(sel){ return document.querySelector(sel); }
  function num(t){ try{ return parseFloat(String(t||'').replace(/[^0-9.\-]/g,'')) || 0; }catch(_){ return 0; } }
  function fmt(n){
    if(!isFinite(n)) return '$—';
    return n >= 1 ? ('$'+n.toFixed(2)) : ('$'+n.toFixed(6));
  }
  function recalc(){
    try{
      var balEl = $('#totalBalance');
      var priceEl = $('#qtcPrice');
      var chEl = $('#qtcChange');
      var usdEl = $('#totalFiat');
      var usdCh = $('#totalFiatChange');
      if(!balEl || !usdEl) return;

      var total = num(balEl.textContent);
      var price = 0;
      if(typeof window !== 'undefined' && typeof window.__lastPrice === 'number'){
        price = window.__lastPrice;
      }else if(priceEl){
        price = num(priceEl.textContent);
      }
      if(isFinite(total) && isFinite(price) && price>0){
        usdEl.textContent = fmt(total*price);
      }
      if(usdCh){
        var ch = (typeof window !== 'undefined' && typeof window.__lastChange === 'number')
                  ? window.__lastChange
                  : (chEl ? num(chEl.textContent) : NaN);
        if(isFinite(ch)){
          var cls = ch>0 ? 'pos' : (ch<0 ? 'neg' : 'neutral');
          usdCh.className = 'change ' + cls;
          usdCh.textContent = (ch>0?'+':'') + ch.toFixed(2) + '%';
        }
      }
    }catch(e){}
  }
  function observe(el, cb){
    if(!el || typeof MutationObserver==='undefined') return;
    try{
      var mo = new MutationObserver(cb);
      mo.observe(el, {characterData:true, childList:true, subtree:true});
    }catch(e){}
  }
  function boot(){
    observe($('#qtcPrice'), recalc);
    observe($('#totalBalance'), recalc);
    setTimeout(recalc, 150);
    setTimeout(recalc, 800);
    setInterval(recalc, 5000);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot, {once:true});
  else boot();
})();