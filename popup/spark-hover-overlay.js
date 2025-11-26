(() => {
  "use strict";
  function boot(){
    const c = document.getElementById('qtcSpark'); if(!c) return;
    const wrap = c.parentElement || c;
    let tip = document.getElementById('qtcHoverTip');
    if(!tip){
      tip = document.createElement('div');
      tip.id = 'qtcHoverTip';
      tip.className = 'sparktip';
      tip.innerHTML = '<div class="p"></div><div class="d muted"></div>';
      wrap.style.position = wrap.style.position || 'relative';
      wrap.appendChild(tip);
    }
    let vline = document.getElementById('qtcHoverLine');
    if(!vline){
      vline = document.createElement('div');
      vline.id = 'qtcHoverLine';
      vline.className = 'sparkvline';
      wrap.appendChild(vline);
    }
    function fmtUSD(x){
      try{ return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:8}).format(x); }
      catch{ return '$'+(x!=null?x:0); }
    }
    function fmtDate(ts){
      const d = new Date(ts);
      const range1d = (window.lastDays && Number(window.lastDays)<=1);
      return range1d ? d.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})
                     : d.toLocaleDateString('es-ES',{day:'2-digit',month:'short'});
    }
    function showAtClientX(clientX){
      const info = window.__qtcSparkInfo; if(!info) return;
      const rect = c.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      const pad = info.pad, n = info.n;
      const step = (info.w - 2*pad) / (n-1 || 1);
      let i = Math.round((clientX - rect.left - pad)/step);
      if (i<0) i=0; if (i>n-1) i=n-1;
      const pt = info.values[i]; if(!pt) return;
      const price = pt[1], ts = pt[0];
      const cx = rect.left + pad + i*step;
      vline.style.display = 'block';
      vline.style.left = (cx - wrapRect.left - 0.5) + 'px';
      vline.style.top = 0; vline.style.bottom = 0;
      tip.style.display = 'block';
      tip.querySelector('.p').textContent = fmtUSD(price);
      tip.querySelector('.d').textContent = fmtDate(ts);
      const tw = tip.offsetWidth || 120;
      const left = Math.min(Math.max(cx - wrapRect.left - tw/2, 2), wrapRect.width - tw - 2);
      tip.style.left = left + 'px'; tip.style.top = '4px';
    }
    const onMove = (ev)=>{ const x = (ev.touches && ev.touches[0]) ? ev.touches[0].clientX : ev.clientX; showAtClientX(x); };
    const onLeave = ()=>{ vline.style.display='none'; tip.style.display='none'; };
    wrap.addEventListener('mousemove', onMove, {passive:true});
    wrap.addEventListener('touchmove', onMove, {passive:true});
    wrap.addEventListener('mouseleave', onLeave, {passive:true});
    wrap.addEventListener('touchend', onLeave, {passive:true});
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot, {once:true}); else boot();
})();