(function(){
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  // Safe formatter for QTC amounts (8 decimals). Keeps compatibility if not previously defined.
  if (typeof window.formatQtc !== 'function') {
    window.formatQtc = function(v){
      const n = (typeof v === 'number') ? v : Number(v || 0);
      return (isFinite(n) ? n : 0).toFixed(8);
    };
  }


  // Global state + expose
  const state = { unlocked:false, cryptoKey:null, keys:[] };
  window.state = state;

  // notify
  function notify(msg,type="info"){ if(type!=="error") return; const n=$('#notif'); if(!n) return; n.textContent=String(msg); n.className='notify error'; n.style.display='block'; setTimeout(()=> n.style.display='none', 4000); }
  window.notify = notify;

// === QTC: 10‑min session envelope 
const QTC_SESS = 'qtcSession';
const QTC_SESS_ENV = 'qtcSessionEnv';
const QTC_SESS_TTL = 10*60*1000; // 10 min

// Robust Base64 helpers (sin spread)
function b64FromBytes(u8){
  let s='', CHUNK=0x8000;
  for(let i=0;i<u8.length;i+=CHUNK){
    s += String.fromCharCode.apply(null, u8.subarray(i, i+CHUNK));
  }
  return btoa(s);
}
function bytesFromB64(b64){
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for(let i=0;i<s.length;i++) out[i] = s.charCodeAt(i);
  return out;
}

// Promisified storage.session (compatible MV3)
const sessGet    = (keys)=>new Promise((res,rej)=>{ try{ chrome.storage.session.get(keys, v=>{ if(chrome.runtime.lastError) rej(chrome.runtime.lastError); else res(v); }); }catch(e){ rej(e);} });
const sessSet    = (obj)=> new Promise((res,rej)=>{ try{ chrome.storage.session.set(obj, ()=>{ if(chrome.runtime.lastError) rej(chrome.runtime.lastError); else res(); }); }catch(e){ rej(e);} });
const sessRemove = (keys)=>new Promise((res,rej)=>{ try{ chrome.storage.session.remove(keys, ()=>{ if(chrome.runtime.lastError) rej(chrome.runtime.lastError); else res(); }); }catch(e){ rej(e);} });

async function makeSessionKey(){ return crypto.getRandomValues(new Uint8Array(32)); }
async function importSessKey(raw){ return crypto.subtle.importKey('raw', raw, {name:'AES-GCM'}, false, ['encrypt','decrypt']); }

async function setSessionEnvelope(){
  try{
    if(!state.keys || !state.keys.length) return;
    const rawKey = await makeSessionKey();
    const key = await importSessKey(rawKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify({keys: state.keys}));
    const ct = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, plain));
    const expiresAt = Date.now() + QTC_SESS_TTL;
    await sessSet({ [QTC_SESS]: { key: b64FromBytes(rawKey), expiresAt },
                    [QTC_SESS_ENV]: { iv: b64FromBytes(iv), ct: b64FromBytes(ct) } });
  }catch(e){ /* noop */ }
}

async function tryRestoreEnvelope(){
  try{
    const got = await sessGet([QTC_SESS, QTC_SESS_ENV]);
    const sess = got[QTC_SESS]; const env = got[QTC_SESS_ENV];
    if(!sess || !env) return false;
    if(Date.now() > (sess.expiresAt||0)){ await sessRemove([QTC_SESS,QTC_SESS_ENV]); return false; }
    const raw = bytesFromB64(sess.key);
    const iv  = bytesFromB64(env.iv);
    const ct  = bytesFromB64(env.ct);
    const key = await importSessKey(raw);
    const plain = new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, ct));
    const obj = JSON.parse(new TextDecoder().decode(plain));
    if(obj && Array.isArray(obj.keys)){
      state.keys = obj.keys;
      state.unlocked = true;
      return true;
    }
    return false;
  }catch(e){ return false; }
}

async function touchEnvelope(){
  try{
    const got = await sessGet([QTC_SESS]);
    const sess = got[QTC_SESS]; if(!sess) return;
    sess.expiresAt = Date.now() + QTC_SESS_TTL;
    await sessSet({ [QTC_SESS]: sess });
  }catch(e){}
}
async function clearEnvelope(){ try{ await sessRemove([QTC_SESS,QTC_SESS_ENV]); }catch(e){} }

function startSessKeepAlive(){
  ['click','keydown','mousemove'].forEach(ev => document.addEventListener(ev, ()=>touchEnvelope(), {passive:true}));
  setInterval(()=>touchEnvelope(), 20000);
}



  // UI helpers
  function setVisible(sel, on){ const el=$(sel); if(el) el.classList.toggle("hidden", !on); }
  function setActiveTab(tab){ $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab===tab)); $$(".tabpane").forEach(p => p.style.display = (p.dataset.pane===tab ? "block":"none")); }

  // WebCrypto vault
  async function deriveKey(password, salt){ const enc=new TextEncoder(); const mat=await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]); return crypto.subtle.deriveKey({name:"PBKDF2",salt,iterations:350000,hash:"SHA-256"}, mat, {name:"AES-GCM",length:256}, false, ["encrypt","decrypt"]); }
  function toB64(bytes){ return btoa(String.fromCharCode(...bytes)); }
  function fromB64(str){ return new Uint8Array(atob(str).split('').map(c=>c.charCodeAt(0))); }

  async function saveVault(seedBytes, password){
    const salt=crypto.getRandomValues(new Uint8Array(16)); const iv=crypto.getRandomValues(new Uint8Array(12));
    const key=await deriveKey(password, salt);
    const ct=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv}, key, seedBytes));
    await chrome.runtime.sendMessage({ type:"QTC_STORE_ENCRYPTED", payload:{ salt:toB64(salt), iv:toB64(iv), ciphertext:toB64(ct) } });
    state.cryptoKey=key; return key;
  }
  async function loadVault(password){
    const resp=await chrome.runtime.sendMessage({ type:"QTC_LOAD_ENCRYPTED" });
    if(!resp?.payload) throw new Error("Vault not found");
    const {salt,iv,ciphertext}=resp.payload;
    const key=await deriveKey(password, fromB64(salt));
    await crypto.subtle.decrypt({name:"AES-GCM", iv:fromB64(iv)}, key, fromB64(ciphertext)); // solo para validar
    state.cryptoKey=key; return key;
  }

  
  async function saveKeysEncrypted(){
    if(!state.cryptoKey) return;
    const enc=new TextEncoder(); const iv=crypto.getRandomValues(new Uint8Array(12));
    const json=JSON.stringify(state.keys);
    const ct=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv}, state.cryptoKey, enc.encode(json)));
    await chrome.storage.local.set({ qtcKeys:{ iv:toB64(iv), ciphertext:toB64(ct) } });
  }
  async function loadKeysEncrypted(){
    if(!state.cryptoKey){ state.keys=[]; renderKeys(); return; }
    const st=await chrome.storage.local.get({ qtcKeys:null }); if(!st.qtcKeys){ state.keys=[]; renderKeys(); return; }
    try{
      const dec=new TextDecoder(); const iv=fromB64(st.qtcKeys.iv); const ct=fromB64(st.qtcKeys.ciphertext);
      const plain=await crypto.subtle.decrypt({name:"AES-GCM", iv}, state.cryptoKey, ct);
      state.keys = JSON.parse(dec.decode(new Uint8Array(plain))) || [];
    }catch(e){ state.keys=[]; }
    renderKeys();
  }
  window.saveKeysEncrypted=saveKeysEncrypted; window.loadKeysEncrypted=loadKeysEncrypted;

  
  function ensureRandom(){
    if (window.Crypto && Crypto.util && typeof Crypto.util.randomBytes !== "function") {
      Crypto.util.randomBytes = function(n){ const b=new Uint8Array(n); crypto.getRandomValues(b); return Array.from(b); };
    }
  }
  function detectCoinjs(){
    ensureRandom();
    const ok = typeof window.coinjs !== "undefined" && coinjs && typeof coinjs.newKeys==="function";
    $("#coinjsStatus").textContent = ok ? "coinjs OK: open‑source logic." : "coinjs NOT detected.";
    return ok;
  }

  function pushKey(addr, wif){ state.keys.push({addr,wif}); renderKeys(); saveKeysEncrypted().catch(()=>notify("Could not save keys","error")); fetchBalances().catch(()=>{}); }
  function renderKeys(){
    
const _al = document.querySelector("#addrList"); if(_al) _al.innerHTML = state.keys.map((k,i)=>`
  <div class="account-row flex items-center justify-between" data-idx="${i}">
    <div class="truncate">
      <div class="flex items-center gap-2">
        <span class="copyIcon copyAddr" title="Copiar" data-addr="${k.addr}" aria-label="Copiar">📋</span>
        <div class="font-mono truncate">${k.addr}</div>
      </div>
      
      <div class="text-xs opacity-70">idx ${i}</div>
    </div>
    <div class="flex items-center gap-3">
      <div class="addrBalance font-mono text-sm" data-addr="${k.addr}">${formatQtc(k.balance || 0)}</div>
      <!-- copy button removed; moved to left as emoji -->
<!--
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="9" y="9" width="10" height="12" rx="2"></rect>
          <path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2"></path>
        </svg>
      -->
      <button class="btn btn-xs" data-action="export-wif" data-idx="${i}">WIF</button>
    </div>
  </div>
`).join("");
const last=state.keys[state.keys.length-1];
try {
  const elAct = document.querySelector("#activityList");
  if (elAct && typeof renderActivity === "function") { renderActivity(); }
} catch(e) { /* noop */ }
  }

  async function exportWIF(){
    if(!state.keys.length) return notify("No keys yet","error");
    try{ await navigator.clipboard.writeText(state.keys[state.keys.length-1].wif); notify("WIF copiado","success"); }catch(e){ notify("No se pudo copiar","error"); }
  }

  function generateAddress(){
    if(!detectCoinjs()) return notify("coinjs no disponible","error");
    try{
      const r = coinjs.newKeys();
      pushKey(r.address, r.wif);
      notify("Address generated","success");
      return r;
    }catch(e){ console.error(e); notify("Error generating address: "+e.message,"error"); }
  }

 
  
function updatePendingChips(inAmt, inCount, outAmt, outCount){
  try{
    const inc = document.getElementById('chipIncoming');
    const out = document.getElementById('chipOutgoing');
    const now = Date.now();
    const grace = 45000; 
    
    if(inc){
      if(inAmt > 0 || inCount > 0){
        inc.textContent = `+${inAmt.toFixed(8)} (${inCount})`;
        inc.classList.remove('hidden'); inc.setAttribute('aria-hidden','false');
        inc.dataset.lastPositive = String(now);
      } else {
        const last = Number(inc && inc.dataset && inc.dataset.lastPositive || 0);
        if (!last || (now - last) > grace){
          inc.classList.add('hidden'); inc.setAttribute('aria-hidden','true');
        } 
      }
    }
    if(out){
      if(outAmt > 0 || outCount > 0){
        out.textContent = `-${outAmt.toFixed(8)} (${outCount})`;
        out.classList.remove('hidden'); out.setAttribute('aria-hidden','false');
        out.dataset.lastPositive = String(now);
      } else {
        const last = Number(out && out.dataset && out.dataset.lastPositive || 0);
        if (!last || (now - last) > grace){
          out.classList.add('hidden'); out.setAttribute('aria-hidden','true');
        }
      }
    }
  }catch(e){ /* silent */ }
}


async function pendingIncomingViaUtxo(addrs){
  let sum=0, cnt=0;
  for(const a of addrs){
    try{
      const url = `https://explorer-api.superquantum.io/address/${encodeURIComponent(a)}/utxo`;
      const r = await fetch(url); const arr = await r.json();
      if(Array.isArray(arr)){
        for(const u of arr){
          if(u && u.status && u.status.confirmed===false){
            sum += (u.value||0)/1e8; cnt += 1;
          }
        }
      }
    }catch(e){ /* ignore */ }
  }
  return {sum, cnt};
}






async function pendingIncomingExternalViaUtxo(addrs){
  const myset = new Set(addrs);
  const utxos = [];
  try{
    for(const a of addrs){
      try{
        const url = `https://explorer-api.superquantum.io/address/${encodeURIComponent(a)}/utxo`;
        const r = await fetch(url); const arr = await r.json();
        if(Array.isArray(arr)){
          for(const u of arr){
            if(u && u.status && u.status.confirmed===false && u.value>0){
              utxos.push({ txid: u.txid, vout: u.vout, value: u.value, addr: u.scriptpubkey_address || a });
            }
          }
        }
      }catch(e){}
    }
  }catch(e){}

  const txcache = new Map();
  let extSum=0, extCnt=0; let chSum=0, chCnt=0;
  for(const u of utxos){
    try{
      let tx = txcache.get(u.txid);
      if(!tx){
        const r = await fetch(`https://explorer-api.superquantum.io/tx/${encodeURIComponent(u.txid)}`);
        tx = await r.json();
        txcache.set(u.txid, tx);
      }
      let spendsOurs = false;
      if(tx && Array.isArray(tx.vin)){
        for(const vin of tx.vin){
          const pv = vin && vin.prevout;
          const addr = pv && pv.scriptpubkey_address;
          if(addr && myset.has(addr)){ spendsOurs = true; break; }
        }
      }
      if(spendsOurs){ chSum += (u.value||0)/1e8; chCnt += 1; }
      else { extSum += (u.value||0)/1e8; extCnt += 1; }
    }catch(e){}
  }
  return { sum: extSum, cnt: extCnt, changeSum: chSum, changeCnt: chCnt };
}

async function pendingOutgoingViaMempool(addrs){
  const myset = new Set(addrs);
  const seen = new Set();
  let sum=0, cnt=0, changeSum=0, changeCnt=0;
  for(const a of addrs){
    try{
      const url = `https://explorer-api.superquantum.io/address/${encodeURIComponent(a)}/txs/mempool`;
      const r = await fetch(url); const txs = await r.json();
      if(Array.isArray(txs)){
        for(const tx of txs){
          const txid = tx && (tx.txid || tx.hash);
          if(!txid || seen.has(txid)) continue;

          let spendsOurs=false;
          if(Array.isArray(tx.vin)){
            for(const vin of tx.vin){
              const pv = vin && vin.prevout;
              const addr = pv && pv.scriptpubkey_address;
              if(addr && myset.has(addr)){ spendsOurs=true; break; }
            }
          }
          if(!spendsOurs) continue;

          let externalOut=0, changeOut=0, changePieces=0;
          if(Array.isArray(tx.vout)){
            for(const v of tx.vout){
              const addr = v && v.scriptpubkey_address;
              const val  = v && v.value;
              if(typeof val === 'number'){
                if(addr && myset.has(addr)){ changeOut += val; changePieces += 1; }
                else { externalOut += val; }
              }
            }
          }
          if(externalOut>0){ seen.add(txid); cnt += 1; sum += externalOut/1e8; }
          if(changeOut>0){ changeSum += changeOut/1e8; changeCnt += changePieces; }
        }
      }
    }catch(e){ /* ignore */ }
  }
  return {sum, cnt, changeSum, changeCnt};
}


let __autoRefreshTimer = null;

function renderMainAddressInline(){
  try{
    const el = document.getElementById('mainAddrText');
    const cp = document.getElementById('mainAddrCopy');
    if(!el || !cp) return;
    const k = (state.keys||[])[(state.keys||[]).length-1];
    if(!k){ el.textContent = ""; cp.setAttribute('data-addr',''); return; }
    el.textContent = k.addr;
    cp.setAttribute('data-addr', k.addr);
  }catch(e){}
}

function startAutoRefresh(){
  try{ if(__autoRefreshTimer) clearInterval(__autoRefreshTimer); }catch(e){}
  __autoRefreshTimer = setInterval(()=>{
    try{ if(state && state.unlocked){ fetchBalances(); } }catch(e){}
  }, 20000);
}
async function fetchBalances(){
    try{
      const addrs = state.keys.map(k=>k.addr); if(!addrs.length){ const t=$("#totalBalance"); if(t) t.textContent="0"; renderMainAddressInline();
      $("#totals").style.display="block"; return; 
  try{ updatePendingChips(incSum, incCnt, outSum, outCnt); }catch(e){}
}
      
      let total = 0; let incSum=0, outSum=0, incCnt=0, outCnt=0;
      for(const a of addrs){
        const url = `https://explorer-api.superquantum.io/address/${encodeURIComponent(a)}`;
        const res = await fetch(url); const j = await res.json();
        let sats = 0;
        if (j && j.chain_stats){ sats += (j.chain_stats.funded_txo_sum||0) - (j.chain_stats.spent_txo_sum||0); }
        
        const coin = sats/1e8;
       
        if(j && j.mempool_stats){
          incSum += (j.mempool_stats.funded_txo_sum||0)/1e8;  incCnt += (j.mempool_stats.funded_txo_count||0);
          outSum += (j.mempool_stats.spent_txo_sum||0)/1e8;   outCnt += (j.mempool_stats.spent_txo_count||0);
        }
        total += coin;
        const cell = document.querySelector(`.addrBalance[data-addr="${a}"]`);
        if (cell) cell.innerHTML = `<b>${coin.toFixed(8)}</b>`;
      }
      window.__qtcTotal = total;
      if (Math.abs(total) < 1e-12) { $("#totalBalance").textContent = '0'; } else { $("#totalBalance").textContent = total.toFixed(8); }
      try{ window.__qtcTotal = total; __recalcTopFiatFromDom(); }catch(_){ } /*__recalc_call_after_total*/
      /* unconfirmedLine auto-row removed */;

      renderMainAddressInline();
      $("#totals").style.display="block";
    }catch(e){ console.warn(e); notify("Could not fetch balance","error"); }
  
 
  try {
    const addrs = state.keys.map(k => k.addr);
    const __inc = await pendingIncomingExternalViaUtxo(addrs);
    const __out = await pendingOutgoingViaMempool(addrs);
    const __incSum  = (__inc.sum  || 0);
    const __incCnt  = (__inc.cnt  || 0);
    const __outSum  = (__out.sum || 0);
    const __outCnt  = (__out.cnt || 0);
    updatePendingChips(__incSum, __incCnt, __outSum, __outCnt);
    try{
      const net = (__incSum - __outSum);
      const el = document.getElementById("unconfirmedLine");
      if(el){
        const sign = net>0 ? "+" : "";
        el.textContent = `Unconfirmed: ${sign}${net.toFixed(8)}`;
        el.style.color = net>0 ? "#118a00" : (net<0 ? "#b64000" : "inherit");
      }
    }catch(e){}
  } catch (e) {}

}
  window.fetchBalances = fetchBalances;


window.__recalcTopFiatFromDom = window.__recalcTopFiatFromDom || (function(){
  function num(t){ try{ return parseFloat(String(t||'').replace(/[^0-9.\-]/g,'')) || 0; }catch(_){ return 0; } }
  function recalc(){
    try{
      var balTxt = (document.querySelector('#totalBalance')||{}).textContent || '0';
      var bal = num(balTxt);
      var price = num((document.querySelector('#qtcPrice')||{}).textContent);
      var usd = bal * price;
      var usdEl = document.querySelector('#totalFiat');
      if(usdEl){
        if (bal === 0 || Math.abs(usd) < 1e-12){
          usdEl.textContent = '$0';
        }else{
          usdEl.textContent = '$' + usd.toFixed(2);
        }
      }
    }catch(e){}
  }
  return recalc;
})();



  async function unlock(){
    const pwd=$("#password").value; if(!pwd) return notify("Enter your password","error");
    try{
      await loadVault(pwd);
      /* QTC session */ await setSessionEnvelope(); startSessKeepAlive();
      state.unlocked=true;
      setVisible("#authSection", false); setVisible("#walletSection", true);
      detectCoinjs();
      await loadKeysEncrypted(); populateFromSelect();
      await fetchBalances();
      notify("Vault unlocked","success");
    }catch(e){ notify("Could not unlock: "+e.message,"error"); }
  }
  async function createVault(){
  const pwd=$("#password").value; if(!pwd) return notify("Create a password","error");
  const seed=crypto.getRandomValues(new Uint8Array(32));
  await saveVault(seed, pwd);


  detectCoinjs();
  let first=null; try{ first = generateAddress(); }catch(e){ console.error(e); }
  state.keys = state.keys || [];
  await saveKeysEncrypted();

  
  const modal = document.getElementById("recoveryModal");
  const wifEl  = document.getElementById("recoveryWif");
  const addrEl = document.getElementById("recoveryAddr");
  if(modal && wifEl && addrEl){
    const last = state.keys[state.keys.length-1] || first || {};
    if(last.wif)  wifEl.value  = last.wif;
    if(last.addr) addrEl.value = last.addr;
    modal.classList.remove("hidden");
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden","false");

    const copyBtn = document.getElementById("copyWifBtn");
    if(copyBtn && !copyBtn.dataset.bound){
      copyBtn.dataset.bound = "1";
      copyBtn.addEventListener("click", async ()=>{
        try{ await navigator.clipboard.writeText(wifEl.value||""); notify("WIF copiado","success"); }
        catch(e){ notify("No se pudo copiar","error"); }
      });
    }

    const confirmBtn = document.getElementById("confirmRecoveryBtn");
    if(confirmBtn && !confirmBtn.dataset.bound){
      confirmBtn.dataset.bound = "1";
      confirmBtn.addEventListener("click", async ()=>{
      
        try {
          const wifNow  = (wifEl && wifEl.value || '').trim();
          const addrNow = (addrEl && addrEl.value || '').trim();
          if (wifNow && addrNow) {
            if (!Array.isArray(state.keys)) state.keys = [];
            const exists = state.keys.some(k => k && k.addr === addrNow);
            if (!exists) {
              state.keys.push({ addr: addrNow, wif: wifNow });
              try { await saveKeysEncrypted(); } catch(e) {}
            }
          }
        } catch(e) {}

        modal.classList.add("hidden");
        modal.style.display = "none";
        modal.setAttribute("aria-hidden","true");
        
        state.unlocked = true;
        setVisible("#authSection", false);
        setVisible("#walletSection", true);
        try{ await setSessionEnvelope(); startSessKeepAlive(); }catch(e){}
try{ await setSessionEnvelope(); startSessKeepAlive(); }catch(e){}
try{ await loadKeysEncrypted(); populateFromSelect(); await fetchBalances(); }catch(e){}
        notify("Billetera creada","success");
        const cb=document.querySelector("#createBtn"); if(cb) cb.style.display="none";
      
        
        try{
          if (window.QTC_gate) { window.QTC_gate(); }
          else {
            const a = document.getElementById('authSection');
            const w = document.getElementById('walletSection');
            if (w){ w.style.display=''; w.classList.remove('hidden'); }
            if (a){ a.style.display='none'; a.classList.add('hidden'); }
          }
        }catch(_){}
});
    }
    return; 
  }


  state.unlocked=true;
  setVisible("#authSection", false);
  setVisible("#walletSection", true);
  try{ await setSessionEnvelope(); startSessKeepAlive(); }catch(e){}
try{ await setSessionEnvelope(); startSessKeepAlive(); }catch(e){}
notify("Billetera creada","success");
}

async function hasVault(){
  try{
    const r = await chrome.runtime.sendMessage({ type: "QTC_LOAD_ENCRYPTED" });
    const p = r && r.payload;
    return !!(p && typeof p.salt==='string' && typeof p.iv==='string' && typeof p.ciphertext==='string' && p.salt.length>0 && p.iv.length>0 && p.ciphertext.length>0);
  }catch(e){ return false; }
}

function setAuthMode(mode){
  const title = document.getElementById('authTitle');
  const pwdLabel = document.getElementById('passwordLabel');
  const pwdHint = document.getElementById('passwordHint');
  const unlockBtn = document.getElementById('unlockBtn');
  const createBtn = document.getElementById('createBtn');
  if(mode==='create'){
    if(title) { title.textContent = 'Create wallet'; title.style.textAlign = 'center'; }
    if(pwdLabel) pwdLabel.textContent = 'Password for your new wallet';
    if(pwdHint) pwdHint.textContent = 'We’ll use this password to encrypt your local vault. It’s not recoverable if you forget it.';
    if(unlockBtn) unlockBtn.style.display = 'none';
    if(createBtn){ createBtn.style.display=''; createBtn.textContent='Create wallet'; }
    const cta=document.getElementById('importWifCta'); if(cta) cta.style.display='';
  }else{
    if(title) title.textContent = 'Unlock';
    if(pwdLabel) pwdLabel.textContent = 'Password';
    if(pwdHint) pwdHint.textContent = '';
    if(unlockBtn) unlockBtn.style.display = '';
    const cta=document.getElementById('importWifCta'); if(cta) cta.style.display='none';
    if(createBtn){ createBtn.textContent='Create vault'; }
  }
}


async function startImportWifFlow(){
  
  const modal = document.getElementById('importWifModal');
  const input = document.getElementById('importWifInput');
  const cancelBtn = document.getElementById('cancelImportWifBtn');
  const confirmBtn = document.getElementById('confirmImportWifBtn');
  if(!modal || !input || !cancelBtn || !confirmBtn){ return notify('No se pudo abrir el importador', 'error'); }

  
  try{
    const pwd = document.getElementById('password')?.value || '';
    if(!pwd){ return notify('Enter a password to encrypt your vault', 'error'); }
    
    let exists=false;
    try{ const resp = await chrome.runtime.sendMessage({type:'QTC_LOAD_ENCRYPTED'}); const p=resp&&resp.payload; exists=!!(p&&p.ciphertext); }catch(e){}
    if(!exists){
      const seed=crypto.getRandomValues(new Uint8Array(32));
      await saveVault(seed, pwd);
    }
  }catch(e){ console.warn(e); }

  modal.classList.remove('hidden'); modal.style.display='flex'; modal.setAttribute('aria-hidden','false');
  input.value='';

  const closeModal = ()=>{ modal.classList.add('hidden'); modal.style.display='none'; modal.setAttribute('aria-hidden','true'); };
  if(!cancelBtn.dataset.bound){ cancelBtn.dataset.bound='1'; cancelBtn.addEventListener('click', closeModal); }

  if(!confirmBtn.dataset.bound){
    confirmBtn.dataset.bound='1';
    confirmBtn.addEventListener('click', async ()=>{
      try{
        const wif = (input.value||'').trim();
        if(!wif) return notify('Pega tu WIF', 'error');
        detectCoinjs();
        let addr='';
        try{
          if(typeof coinjs.wif2address === 'function'){ addr = (coinjs.wif2address(wif)||{}).address || ""; }
        }catch(e){}
        if(!addr){ return notify('Invalid WIF', 'error'); }
        pushKey(addr, wif);
        await saveKeysEncrypted();
        notify('WIF importado', 'success');
        closeModal();
        
        state.unlocked = true;
        setVisible('#authSection', false);
        setVisible('#walletSection', true);
        try{ await setSessionEnvelope(); startSessKeepAlive(); }catch(e){}
try{ await setSessionEnvelope(); startSessKeepAlive(); }catch(e){}
try{ await loadKeysEncrypted(); populateFromSelect(); await fetchBalances(); }catch(e){}
        const cb=document.querySelector('#createBtn'); if(cb) cb.style.display='none';
      }catch(e){ console.error(e); notify('Could not import', 'error'); }
    });
  }
}


async function enterWalletAfterAuth(){
  try{
    
    if (typeof saveKeysEncrypted === 'function') {
      try { await saveKeysEncrypted(); } catch(e) { console.warn('saveKeysEncrypted:', e); }
    }
    
    await new Promise(r => setTimeout(r, 60));
    if (typeof loadKeysEncrypted === 'function') {
      try { await loadKeysEncrypted(); } catch(e) { console.warn('loadKeysEncrypted:', e); }
    }
    if (typeof populateFromSelect === 'function') {
      try { populateFromSelect(); } catch(e) { console.warn('populateFromSelect:', e); }
    }
    if (typeof fetchBalances === 'function') {
      try { await fetchBalances(); } catch(e) { console.warn('fetchBalances:', e); }
    }
  }catch(e){ console.warn('enterWalletAfterAuth:', e); }
}
function bindUI(){
  
  
 
  const esb = document.getElementById('easySendBtn');
  if (esb && !esb.dataset.bound){
    esb.dataset.bound='1';
    esb.addEventListener('click', async ()=>{
      try { await easySend(); } catch(e){ try{ notify(e.message||'Error al enviar','error'); }catch(_){} }
    });
  }

  const importLink = document.getElementById('importWifLink');
  if(importLink && !importLink.dataset.bound){
    importLink.dataset.bound='1';
    importLink.addEventListener('click', (e)=>{ e.preventDefault(); startImportWifFlow(); });
  }

  const ub = document.getElementById('unlockBtn');
  const cb = document.getElementById('createBtn');
  if (ub && !ub.dataset.bound){ ub.dataset.bound="1"; ub.addEventListener('click', ()=>{ try{ unlock(); }catch(e){ console.warn(e); } }); }
  if (cb && !cb.dataset.bound){ cb.dataset.bound="1"; cb.addEventListener('click', ()=>{ try{ createVault(); }catch(e){ console.warn(e); } }); }


  document.querySelectorAll('.tab').forEach(btn=>{
    if(btn.dataset.bound) return; btn.dataset.bound="1";
    btn.addEventListener('click', ()=>{
      const t = btn.dataset.tab; document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active', b===btn));
      document.querySelectorAll('.tabpane').forEach(p=>p.style.display = (p.dataset.pane===t ? 'block' : 'none'));
    });
  });
}
document.addEventListener("DOMContentLoaded", ()=>{ 
    try{ startAutoRefresh(); }catch(e){}
  
  try{ setAuthMode("create"); }catch(e){}
  bindUI(); populateFromSelect(); try{ setAuthMode("create"); }catch(e){}

  (async ()=>{
    try{
      const resp = await chrome.runtime.sendMessage({ type:"QTC_LOAD_ENCRYPTED" });
      const exists = !!(resp && resp.payload);
      const cb = document.querySelector('#createBtn'); const ub = document.querySelector('#unlockBtn');
      if(exists){ try{ setAuthMode('unlock'); }catch(e){} if(cb) cb.style.display='none'; if(ub) ub.style.display=''; }
      else { try{ setAuthMode('create'); }catch(e){} if(cb) cb.style.display=''; if(ub) ub.style.display='none'; } try{ setAuthMode(exists ? 'unlock' : 'create'); }catch(e){}
    }catch(e){  }
  })();
});
})();

function populateFromSelect(){
  const sel = document.querySelector('#easyFrom'); if(!sel) return;
  sel.innerHTML = (state.keys||[]).map((k,i)=>`<option value="${i}">${k.addr} (idx ${i})</option>`).join("");
}


async function fetchScriptPubKey(txid, vout){
  const url = `https://explorer-api.superquantum.io/tx/${txid}`;
  const r = await fetch(url);
  if(!r.ok) throw new Error(`tx ${txid} ${r.status}`);
  const j = await r.json();
  if(!j || !Array.isArray(j.vout) || !j.vout[vout]) throw new Error("tx vout missing");
  return j.vout[vout].scriptpubkey;
}

async function fetchUTXOsEsplora(address){
  const url = `https://explorer-api.superquantum.io/address/${encodeURIComponent(address)}/utxo`;
  const r = await fetch(url);
  if(!r.ok) throw new Error(`UTXO fetch ${r.status}`);
  return await r.json(); 
}

function reverseHex(h){ return (h||'').match(/.{1,2}/g).reverse().join(''); }
function estimateVSize(numIn, numOut){
  
  return Math.ceil(148*numIn + 34*numOut + 10);
}


async function buildAndSignTx(fromIdx, toAddress, amountQtc, feeSatPerByte){
  if (!coinjs || !coinjs.transaction) throw new Error("coinjs no disponible");
  const from = state.keys[fromIdx]; if(!from) throw new Error("invalid origin");

  return await new Promise((resolve, reject)=>{
    try{
      const tx = coinjs.transaction();

      
  
  tx.version = 2;

      tx.addUnspent(from.addr, function(data){
        try{
          if(!data || typeof data.value === "undefined"){
            return reject(new Error("UTXOs no disponibles"));
          }

          
          const nIn = (data.unspent && data.unspent.length) ? data.unspent.length : 1;
          const nOut = 1 + 1; 
          const vsize = Math.ceil(148*nIn + 34*nOut + 10);
          const feeSat = Math.ceil(vsize * feeSatPerByte);
          const feeQTC = feeSat / 1e8;

          const totalQTC = (data.value/1e8);
          const changeQTC = totalQTC - amountQtc - feeQTC;
          if (changeQTC < 0) return reject(new Error("Insufficient funds"));

         
          tx.addoutput(toAddress, Number(amountQtc).toFixed(8));
          if (changeQTC > 0) tx.addoutput(from.addr, Number(changeQTC).toFixed(8));

          
          const tx2 = coinjs.transaction();
const txu = tx2.deserialize(tx.serialize());

txu.version = 2;


for (let i = 0; i < txu.ins.length; i++) {
  
  const tmp = coinjs.transaction();
  const tmpu = tmp.deserialize(txu.serialize());
  for (let j = 0; j < tmpu.ins.length; j++) { tmpu.ins[j].script = coinjs.script(); }
  
  tmpu.ins[i].script = coinjs.script().spendToScript(from.addr);
  
  const sighex = tmpu.transactionSig(i, from.wif, 1);
 
  const pub = coinjs.wif2pubkey(from.wif).pubkey;
  const sc = coinjs.script();
  sc.writeBytes(Crypto.util.hexToBytes(sighex));
  sc.writeBytes(Crypto.util.hexToBytes(pub));
  txu.ins[i].script = sc;
}
const hex = txu.serialize();
if (!hex || typeof hex !== 'string') return reject(new Error("Firma fallida"));

          
          try {
            window.__qtcSendDebug = {
              flow: "official-addUnspent",
              from: from.addr, to: toAddress,
              amountQTC: amountQtc, feeSatPerByte,
              inputs: (data.unspent||[]).map(u=>({tx: u.tx, n: u.n, value: u.value})),
              totalQTC, vsize, feeSat, changeQTC,
              hexLen: hex.length, hexHead: hex.slice(0,24)
            };
            console.log("QTC SEND DEBUG (official)", window.__qtcSendDebug);
          } catch(e){}

          resolve(hex);
        }catch(e){
          reject(e);
        }
      });
    }catch(e){
      reject(e);
    }
  });
}


async function easySend(){
  try{
    const __sel = document.querySelector('#easyFrom');
    const idx = __sel ? Number(__sel.value||"0") : Math.max(0, (state.keys||[]).length-1);
    const to = (document.querySelector('#easyTo').value||"").trim();
    const amt = Number(document.querySelector('#easyAmount').value||"0");
    const fee = Number(document.querySelector('#easyFee').value||"5");
    if(!to) throw new Error("Recipient is required");
    if(!amt || amt<=0) throw new Error("Invalid amount");
    if(!fee || fee<=0) throw new Error("Invalid fee");
    const hex = await buildAndSignTx(idx, to, amt, fee);
    if (!(typeof hex==='string' && hex.length>=200 && /^[0-9a-fA-F]+$/.test(hex))) {  document.querySelector('#easySendOut').textContent = 'Invalid TX (hex corto o no-hex)';  notify('Invalid TX','error');
    try{ await fetchBalances(); setTimeout(()=>{ try{ fetchBalances(); }catch(e){} }, 1500); }catch(e){}
    return;}try{ var txArea=document.querySelector('#rawtx'); if(txArea){ txArea.value = hex; } }catch(e){}try {
      const dbg = window.__qtcSendDebug || {};
      document.querySelector('#easySendOut').textContent = 'Preparing transaction…';
    } catch(e){}
    // broadcast via SW
    const res=await chrome.runtime.sendMessage({ type:"QTC_BROADCAST", rawtx:hex });
    document.querySelector('#easySendOut').textContent = (res && res.ok) ? 'Transaction sent correctamente.' : ('Send error: ' + ((res&& (res.error||res.status)) || 'unknown'));
    notify(res.ok ? "Transaction sent" : ("Broadcast error: "+(res.error||res.status)), res.ok ? "success":"error");
  }catch(e){
    document.querySelector('#easySendOut').textContent = String(e);
    notify(String(e), "error"); 
  }
}



document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="export-wif"]');
  if (!btn) return;
  const idx = parseInt(btn.dataset.idx, 10);
  exportWIFByIdx(idx);
});

function exportWIFByIdx(idx){
  const k = (state.keys || [])[idx];
  if (!k || !k.wif){ notify("Key for that address was not found","error"); return; }
 
  (navigator.clipboard && navigator.clipboard.writeText ?
    navigator.clipboard.writeText(k.wif).then(()=>notify("WIF copiado al portapapeles","success")) :
    Promise.reject()
  ).catch(()=>{
    const blob = new Blob([k.wif], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qtc-wif-idx${idx}-${(k.addr||'').slice(0,8)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    notify("WIF exportado como archivo .txt","success");
  });
}



(function(){
  const list = document.getElementById('addrList');
  if (!list) return;
  list.addEventListener('click', async (ev)=>{
    const btn = ev.target.closest('.copyAddr');
    if (!btn) return;
    const addr = btn.getAttribute('data-addr');
    try{
      await navigator.clipboard.writeText(addr);
      notify('Address copied','success');
    }catch(e){
      try{
        const ta = document.createElement('textarea');
        ta.value = addr; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
        notify('Address copied','success');
      }catch(err){ notify('No se pudo copiar','error'); }
    }
  });
})();


async function renderActivity(){
  try{
    const cont = document.querySelector("#activityList");
    if(!cont) return;
    const keys = (window.state && Array.isArray(state.keys)) ? state.keys : [];
    const k = keys[keys.length-1];
    if(!k){ cont.innerHTML = '<div class="muted">No addresses yet.</div>'; return; }

    cont.innerHTML = '<div class="muted">Cargando actividad…</div>';

    const API = 'https://explorer-api.superquantum.io';
    const WEB = 'https://explorer.superquantum.io';
    const addr = encodeURIComponent(k.addr);

    Promise.allSettled([
      fetch(`${API}/address/${addr}/txs/mempool`),
      fetch(`${API}/address/${addr}/txs`)
    ]).then(async ([mem, chain])=>{
      const memok = (mem.status === 'fulfilled') ? await mem.value.json().catch(()=>[]) : [];
      const chainok = (chain.status === 'fulfilled') ? await chain.value.json().catch(()=>[]) : [];
      const seen = new Set();
      const txs = [...memok, ...chainok].filter(tx=>{
        if(!tx || !tx.txid) return false;
        if(seen.has(tx.txid)) return false;
        seen.add(tx.txid);
        return true;
      });

      function deltaFor(tx, a){
        let cin=0, cout=0;
        (tx.vin||[]).forEach(v=>{ if(v?.prevout?.scriptpubkey_address===a) cin += (v.prevout.value||0) });
        (tx.vout||[]).forEach(o=>{ if(o?.scriptpubkey_address===a) cout += (o.value||0) });
        return (cout - cin)/1e8;
      }
      function firstExternalOut(tx, my){
        const out = (tx.vout||[]).find(o=>o?.scriptpubkey_address && o.scriptpubkey_address!==my);
        return out?.scriptpubkey_address || null;
      }
      function firstInputAddr(tx){
        return tx?.vin?.[0]?.prevout?.scriptpubkey_address || null;
      }

      const rows = txs.map(tx=>{
        const d = deltaFor(tx, k.addr);
        const isIn = d > 0;
        const qty = Math.abs(d);
        const counter = isIn ? firstInputAddr(tx) : firstExternalOut(tx, k.addr);
        const dirText = isIn ? "Received" : "Sent";
        const isPending = !(tx && tx.status && tx.status.confirmed);
        const pendBadge = isPending ? '<span class="pill pending" title="Pending">● Pending</span>' : '';
        const txURL = `${WEB}/tx/${encodeURIComponent(tx.txid)}`;
        const addrURL = counter ? `${WEB}/address/${encodeURIComponent(counter)}` : null;

        const head = `<div class="tx-head">
            <div class="tx-main">
              ${pendBadge}
              <span class="badge ${isIn?'green':'orange'}">${isIn?'+':'−'}</span>
              <b>${dirText}</b> · ${qty.toFixed(8)} QTC
            </div>
            <div class="tx-toggle" aria-hidden="true">▾</div>
          </div>`;

        const details = `<div class="tx-details">
            <div class="tx-sub">${addrURL ? `<a href="${addrURL}" target="_blank" rel="noopener">${counter || ''}</a>` : 'unknown'}</div>
            <div class="tx-sub"><a href="${txURL}" target="_blank" rel="noopener">${tx.txid || ''}</a></div>
          </div>`;

        return `<div class="tx-row${isPending?' pending':''}" role="button" tabindex="0" aria-expanded="false">${head}${details}</div>`;
      });

      cont.innerHTML = rows.length ? `<div class="list">${rows.join('')}</div>` : '<div class="muted">No activity yet.</div>';

      
      cont.querySelectorAll('.tx-row').forEach(row=>{
        row.addEventListener('click', ()=>{
          const open = row.getAttribute('aria-expanded') === 'true';
          row.setAttribute('aria-expanded', String(!open));
          row.classList.toggle('open', !open);
        });
        row.addEventListener('keydown', (ev)=>{
          if(ev.key==='Enter' || ev.key===' '){ ev.preventDefault(); row.click(); }
        });
      });
    }).catch(e=>{
      console.error("renderActivity error", e);
      cont.innerHTML = '<div class="muted">No se pudo cargar la actividad.</div>';
    });
  }catch(e){
    console.error("renderActivity error", e);
  }
}



document.addEventListener('click', (ev)=>{
  const row = ev.target.closest?.('.tx-row');
  if(!row) return;
  const open = row.classList.toggle('open');
  row.setAttribute('aria-expanded', open ? 'true' : 'false');
});

document.addEventListener('keydown', (ev)=>{
  if(ev.key !== 'Enter' && ev.key !== ' ') return;
  const row = ev.target.closest?.('.tx-row');
  if(!row) return;
  ev.preventDefault();
  const open = row.classList.toggle('open');
  row.setAttribute('aria-expanded', open ? 'true' : 'false');
});


document.addEventListener('click', (ev)=>{
  const tab = ev.target.closest?.('.tab[data-tab="receive"]');
  if(tab) setTimeout(renderActivity, 0);
}, {passive:true});


['visibilitychange','focus'].forEach(ev => document.addEventListener(ev, renderActivity, {passive:true}));






  function updateTotalsFiat(price, ch24){
    try{
      const total = (typeof window.__qtcTotal === 'number') ? window.__qtcTotal : parseFloat((document.getElementById('totalBalance')||{}).textContent||"0") || 0;
      const elFiat = document.getElementById('totalFiat');
      const elCh   = document.getElementById('totalFiatChange');
      if (elFiat) elFiat.textContent = fmtUSD(total * (price||0));
      if (elCh){
        const sign = ch24>0 ? 'pos' : (ch24<0 ? 'neg' : 'neutral');
        elCh.className = `change ${sign}`;
        elCh.textContent = (ch24>0?'+':'') + (isFinite(ch24)?ch24.toFixed(2):'0.00') + '%';
      }
    }catch(e){}
  }

(function(){
  const API_DETAIL = 'https://api.coingecko.com/api/v3/coins/qubitcoin-2?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=true';
  const API_CHART = (days)=> `https://api.coingecko.com/api/v3/coins/qubitcoin-2/market_chart?vs_currency=usd&days=${days}`;
  let lastDays = 1;
  let lastTs = 0;

  function fmtUSD(v){ 
    const n = Number(v||0);
    return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(6)}`;
  }

  function drawSpark(values){
  try{
    const c = document.getElementById('qtcSpark');
    if(!c) return;
    const ctx = c.getContext('2d');
    const w=c.width, h=c.height;
    ctx.clearRect(0,0,w,h);
    if(!values || !values.length) return;
    const ys = values.map(p=>p[1]);
    const min = Math.min(...ys), max=Math.max(...ys);
    const pad = 6;
    const mapX = (i)=> pad + (w-2*pad) * (i/(ys.length-1));
    const mapY = (y)=> h-pad - (h-2*pad) * ((y-min)/(max-min||1));
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ys.forEach((y,i)=>{
      const x=mapX(i), yy=mapY(y);
      if(i===0) ctx.moveTo(x,yy); else ctx.lineTo(x,yy);
    });
    ctx.strokeStyle = (ys[ys.length-1] >= ys[0]) ? 'rgba(76,195,138,1)' : 'rgba(247,107,107,1)';
    ctx.stroke();
    window.__qtcSparkInfo = {
      values: values,
      min: min, max: max, n: ys.length,
      pad: pad, w: c.width, h: c.height
    };
  }catch(e){ /* noop */ }
}

  async function loadDetail(){
    const elPrice = document.getElementById('qtcPrice');
    const elChange = document.getElementById('qtcChange');
    const elUpdated = document.getElementById('qtcUpdated');
    try{
      const r = await fetch(API_DETAIL);
      const j = await r.json();
      const price = j?.market_data?.current_price?.usd;
      const ch24 = j?.market_data?.price_change_percentage_24h;
      if(typeof price === 'number'){
        elPrice.textContent = fmtUSD(price);
      }
      if(typeof ch24 === 'number'){
        const sign = ch24>0 ? 'pos' : (ch24<0 ? 'neg':'neutral');
        elChange.className = `change ${sign}`;
        elChange.textContent = (ch24>0?'+':'') + ch24.toFixed(2) + '%';
      }
      try{ window.__lastPrice = price; window.__lastChange = ch24; __recalcTopFiatFromDom(); }catch(_){ } /*__recalc_call_after_price*/
      elUpdated.textContent = ''; try{ elUpdated.style.display='none'; }catch(_){}
    }catch(e){
      elUpdated.textContent = ''; try{ elUpdated.style.display='none'; }catch(_){}
    }
  }

  async function loadChart(days){
    try{
      const r = await fetch(API_CHART(days));
      const j = await r.json();
      const arr = j?.prices || [];
      drawSpark(arr);
      lastTs = Date.now();
    }catch(e){ /* noop */ }
  }

  function activateRange(btn){
    document.querySelectorAll('#priceWidget .rbtn').forEach(b=>b.classList.toggle('active', b===btn));
  }

  function initPriceWidget(){

 
  try{
    const host = document.querySelector('.tabpane[data-pane="home"] #priceWidget');
    document.querySelectorAll('#qtcSpark, #qtcPrice, #qtcChange, #qtcUpdated, .price-line, .spark-wrap, .range').forEach(el=>{
      if(!host || !el.closest('.tabpane[data-pane="home"] #priceWidget')) el.remove();
    });
  }catch(e){}

    const w = document.getElementById('priceWidget');
    if(!w) return;
  
    w.addEventListener('click', (ev)=>{
      const b = ev.target.closest?.('.rbtn');
      if(!b) return;
      const days = parseInt(b.dataset.range,10)||1;
      lastDays = days; activateRange(b);
      loadChart(days);
    }, {passive:true});
   
    loadDetail(); loadChart(lastDays);
   
    setInterval(()=>{ loadDetail(); loadChart(lastDays); }, 60000);
  }

  
  document.addEventListener('click', (ev)=>{
    const tab = ev.target.closest?.('.tab[data-tab="home"]');
    if(tab) setTimeout(initPriceWidget, 0);
  }, {passive:true});
  
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', initPriceWidget);
  else initPriceWidget();
})();


(function(){
  function wireOptionsBtn(){
    try{
      const btn = document.getElementById('openOptions');
      if(!btn || btn.dataset.bound === "1") return;
      btn.dataset.bound = "1";
      btn.addEventListener('click', async (e)=>{
        e.preventDefault();
        try{
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.openOptionsPage){
            chrome.runtime.openOptionsPage();
          } else if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.openOptionsPage){
            browser.runtime.openOptionsPage();
          } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL){
            const url = chrome.runtime.getURL('options/index.html');
            window.open(url, '_blank');
          } else {
            window.open('options/index.html','_blank');
          }
        }catch(err){
          try{
            const url = (chrome && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL('options/index.html') : 'options/index.html';
            window.open(url,'_blank');
          }catch(_){ /* noop */ }
        }
      }, {passive:false});
    }catch(e){ /* noop */ }
  }
  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', wireOptionsBtn); }
  else { wireOptionsBtn(); }
})();




document.addEventListener('click', async (ev)=>{
  const btn = ev.target.closest('.copyAddr'); if(!btn) return;
  if (btn.closest('#addrList')) return; 
  const addr = btn.getAttribute('data-addr') || btn.dataset.addr;
  if(!addr) return;
  try{
    await navigator.clipboard.writeText(addr);
    notify('Address copied','success');
  }catch(e){
    try{
      const ta = document.createElement('textarea'); ta.value = addr;
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      notify('Address copied','success');
    }catch(err){ notify('No se pudo copiar','error'); }
  }
});




function __recalcTopFiatFromDom(){
  try{
    const bal = document.getElementById('totalBalance');
    const usd = document.getElementById('totalFiat');
    if(!bal || !usd) return;
    const priceNode = document.getElementById('qtcPrice');
    const chNode = document.getElementById('qtcChange');
    const num = (t)=>{ try{ return parseFloat(String(t||'').replace(/[^0-9.\-]/g,''))||0; }catch(_){ return 0; } };
    const total = num(bal.textContent);
    const price = (typeof window.__lastPrice==='number') ? window.__lastPrice : (priceNode ? num(priceNode.textContent) : 0);
    if(price>0){ usd.textContent = fmtUSD(total*price); }
    const chTop = document.getElementById('totalFiatChange');
    if(chTop){
      const ch = (typeof window.__lastChange==='number') ? window.__lastChange : (chNode ? num(chNode.textContent) : NaN);
      if(isFinite(ch)){
        const sign = ch>0 ? 'pos' : (ch<0 ? 'neg' : 'neutral');
        chTop.className = `change ${sign}`;
        chTop.textContent = (ch>0?'+':'') + ch.toFixed(2) + '%';
      }
    }
  }catch(e){}
}
