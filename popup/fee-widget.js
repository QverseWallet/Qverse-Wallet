(() => {
  "use strict";
  const ENDPOINT = "https://explorer-api.superquantum.io/fee-estimates";
  const $ = (s, r=document) => r.querySelector(s);
  function computeAvg(obj){
    try{
      if (!obj || typeof obj !== "object") return null;
      const pick = [3,6,10].map(n => obj[String(n)]).filter(x => typeof x === "number");
      if (pick.length) return Math.round(pick.reduce((a,b)=>a+b,0)/pick.length);
      const vals = Object.entries(obj).map(([k,v]) => [Number(k), Number(v)])
        .filter(([k,v]) => Number.isFinite(k) && k<=25 && Number.isFinite(v)).map(([,v]) => v);
      if (vals.length) return Math.round(vals.reduce((a,b)=>a+b,0)/vals.length);
      return null;
    } catch { return null; }
  }
  function ensureRow(){
    let row = document.getElementById("feeRowGrid");
    if (row) return row;
    const pane = document.querySelector('.tabpane[data-pane="home"]')
              || document.querySelector('.tabpane[data-pane="dashboard"]')
              || document.querySelector('.tabpane[data-pane="wallet"]')
              || document.querySelector('.tabpane');
    if(!pane) return null;
    row = document.createElement("div");
    row.id = "feeRowGrid";
    row.className = "fee-rowgrid";
    row.innerHTML = `
      <div class="panel fee-panel flex1">
        <div class="panel-title">Average fee</div>
        <div class="fee-row"><span id="feeAvgValue">—</span><span class="muted">&nbsp;sats/byte</span></div>
      </div>
      <div class="panel stats-panel flex1">
        <div class="panel-title">Stats</div>
        <div class="stats-placeholder muted">—</div>
      </div>
    `;
    const price = document.getElementById("priceCard")
              || (pane.querySelector("#qtcSpark") && pane.querySelector("#qtcSpark").closest(".panel"))
              || pane.querySelector(".price-card");
    if (price && price.parentNode===pane) price.insertAdjacentElement("beforebegin", row);
    else pane.insertBefore(row, pane.firstChild);
    if (!document.getElementById("feeRowStyle")){
      const st = document.createElement("style");
      st.id = "feeRowStyle";
      st.textContent = `
        #feeRowGrid{ display:flex; gap:16px; margin:0 0 10px 0; width:100%; }
        #feeRowGrid .panel{ padding:10px 12px; border-radius:14px; background:var(--panel-bg, rgba(255,255,255,.03)); border:1px solid rgba(255,255,255,.06); }
        #feeRowGrid .panel-title{ font-weight:700; font-size:13px; color:var(--muted,#93a4b1); margin-bottom:6px; }
        #feeRowGrid .fee-row{ font-size:18px; font-weight:800; letter-spacing:.2px; display:flex; align-items:baseline; gap:6px; }
        #feeRowGrid .flex1{ flex:1 1 0; min-width:0; }
      `;
      document.head.appendChild(st);
    }
    return row;
  }
  async function refreshFees(){
    const row = ensureRow();
    const elVal = $("#feeAvgValue");
    if(!row || !elVal) return;
    try{
      const res = await fetch(ENDPOINT, {cache:"no-store"});
      let avg = null;
      if (res.ok){
        const j = await res.json();
        avg = computeAvg(j);
      }
      elVal.textContent = (avg!=null) ? String(avg) : "—";
    }catch{ elVal.textContent = "—"; }
  }
  function boot(){ ensureRow(); refreshFees(); setInterval(refreshFees, 120000); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, {once:true}); else boot();
})();