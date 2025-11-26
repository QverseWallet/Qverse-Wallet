
(() => {
  "use strict";

 
  const ENDPOINT = "https://qubitcoin.luckypool.io/api/stats";

  const $ = (s, r=document)=>r.querySelector(s);

  function ensureSlot(){
    const stats = document.querySelector("#feeRowGrid .stats-panel");
    if(!stats) return null;
    if(!stats.querySelector("#netHashrateVal")){
      stats.innerHTML = `
        <div class="panel-title">Hashrate</div>
        <div class="hash-row"><span id="netHashrateVal">—</span></div>
      `;
    }
    return stats.querySelector("#netHashrateVal");
  }

  
  function parseHashrateString(str){
    if (!str) return null;
    const m = String(str).trim().match(/([0-9]+(?:\.[0-9]+)?)\s*([EPTGMk]?)/i);
    if (!m) return null;
    const val = parseFloat(m[1]);
    const unit = (m[2]||"").toUpperCase();
    const mult = unit === "E" ? 1e18 :
                 unit === "P" ? 1e15 :
                 unit === "T" ? 1e12 :
                 unit === "G" ? 1e9  :
                 unit === "M" ? 1e6  :
                 unit === "K" ? 1e3  : 1;
    return val * mult;
  }

 
  function digHashrate(obj){
    const KEYS = [
      "hashrate","network_hashrate","hash_rate","net_hashrate","networkhashps","hashRate",
      "networkHashrate","networkHashesPerSecond","hashesPerSecond","hashespersec",
      "net_hashrate_str","hashrateString","network_hashrate_str"
    ];
    const stack = [obj];
    while (stack.length){
      const it = stack.pop();
      if (!it || typeof it!=="object") continue;
      for (const k of Object.keys(it)){
        const v = it[k];
        if (KEYS.includes(k)){
          if (typeof v === "number" && isFinite(v)) return v;
          if (typeof v === "string"){
            const p = parseHashrateString(v);
            if (p != null) return p;
          }
        }
        if (v && typeof v === "object") stack.push(v);
      }
    }
    return null;
  }

  function fmtHashrate(h){
    if (h == null || !isFinite(h)) return "—";
    const units = ["H/s","kH/s","MH/s","GH/s","TH/s","PH/s","EH/s"];
    let u = 0; let v = Math.abs(h);
    while (v >= 1000 && u < units.length-1){ v/=1000; u++; }
    const num = (v>=100 ? v.toFixed(0) : v>=10 ? v.toFixed(1) : v.toFixed(2));
    return `${num} ${units[u]}`;
  }

  async function refresh(){
    const slot = ensureSlot(); if(!slot) return;
    try{
      const r = await fetch(ENDPOINT, {cache:"no-store"});
      if (!r.ok) throw new Error(r.statusText);
      const j = await r.json();
      const hr = digHashrate(j);
      slot.textContent = fmtHashrate(hr);
    }catch{
      slot.textContent = "—";
    }
  }

  function boot(){
    ensureSlot();
    refresh();
    setInterval(refresh, 120000);
  }

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", boot, {once:true});
  }else{
    boot();
  }
})();
