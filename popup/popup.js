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

  // Global state (NOT exposed directly for security)
  const state = { unlocked:false, cryptoKey:null, keys:[] };
  
  // Secure state accessors - only expose what's needed
  window.getWalletState = () => ({ 
    unlocked: state.unlocked, 
    keyCount: state.keys.length,
    hasKeys: state.keys.length > 0
  });
  window.getKeys = () => state.keys.slice(); // Return copy, not reference
  window.getActiveKey = () => {
    const idx = window.activeWalletIndex || 0;
    const k = state.keys[idx];
    return k ? { addr: k.addr } : null; // Never expose WIF through this
  };
  window.isUnlocked = () => state.unlocked;
  
  // Legacy compatibility - limited read-only access
  Object.defineProperty(window, 'state', {
    get: function() {
      return { 
        unlocked: state.unlocked, 
        keys: state.keys,
      };
    },
    set: function() {},
    configurable: false
  });

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
      // Get TTL from storage
      let ttl = 900000;
      try {
        const ttlData = await chrome.storage.local.get({qtcAutolockTTL: 900000});
        ttl = ttlData.qtcAutolockTTL || 900000;
      } catch(e){}
      
      // Update QTC_SESS envelope
      const got = await sessGet([QTC_SESS]);
      const sess = got[QTC_SESS]; 
      if(sess) {
        sess.expiresAt = (ttl === 0) ? 0 : (Date.now() + ttl);
        await sessSet({ [QTC_SESS]: sess });
      }
      
      // Update qtcTempKeysEnc expiration
      const r = await chrome.storage.session.get({qtcTempKeysEnc: null});
      if(r && r.qtcTempKeysEnc){
        r.qtcTempKeysEnc.expiresAt = (ttl === 0) ? 0 : (Date.now() + ttl);
        await chrome.storage.session.set({qtcTempKeysEnc: r.qtcTempKeysEnc});
      }
    }catch(e){}
  }
  async function clearEnvelope(){ 
    try{ 
      await sessRemove([QTC_SESS,QTC_SESS_ENV]); 
      await chrome.storage.session.remove(['qtcTempKeysEnc']);
    }catch(e){} 
  }
  window.clearEnvelope = clearEnvelope;

  // Expose for recovery
  window.tryRestoreEnvelope = tryRestoreEnvelope;
  window.setSessionEnvelope = setSessionEnvelope;

  function startSessKeepAlive(){
    // Only renew on actual user activity, NOT on interval
    ['click','keydown','mousemove'].forEach(ev => document.addEventListener(ev, ()=>touchEnvelope(), {passive:true}));
  }

  // Try to restore from robust storage.session (ENCRYPTED)
  async function tryRestoreFromStorageSession(){
    try {
      // Try new encrypted format first
      const r = await chrome.storage.session.get({qtcTempKeysEnc: null});
      if(r && r.qtcTempKeysEnc && r.qtcTempKeysEnc.key && r.qtcTempKeysEnc.iv && r.qtcTempKeysEnc.ct){
        const enc = r.qtcTempKeysEnc;
        
        // Check expiration (expiresAt=0 means never expire)
        if(enc.expiresAt && enc.expiresAt !== 0 && Date.now() > enc.expiresAt){
          // Session expired - clear it
          await chrome.storage.session.remove(['qtcTempKeysEnc']);
          return false;
        }
        
        const sessKey = bytesFromB64(enc.key);
        const iv = bytesFromB64(enc.iv);
        const ct = bytesFromB64(enc.ct);
        const cryptoKey = await importSessKey(sessKey);
        const plaintext = new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM', iv}, cryptoKey, ct));
        const keys = JSON.parse(new TextDecoder().decode(plaintext));
        if(Array.isArray(keys) && keys.length > 0){
          state.keys = keys;
          state.unlocked = true;
          return true;
        }
      }
    } catch(e){}
    return false;
  }

// Active wallet index (Global)
  window.activeWalletIndex = 0;

// Centralized state update
function setActiveWallet(idx){
  const keys = state.keys || [];
  idx = parseInt(idx, 10); 
  
  // Safety check
  if(!keys.length) return;
  if(isNaN(idx)) return;
  if(idx < 0) idx = 0;
  if(idx >= keys.length) idx = keys.length - 1; 
  
  window.activeWalletIndex = idx;
  chrome.storage.local.set({activeWalletIndex: idx});
  
  // Update UI immediately
  updateWalletSelector();
  renderMainAddressInline();
  try{ resetPendingChips(); }catch(e){}
  
  // Visual feedback of loading
  const tb = document.getElementById("totalBalance");
  if(tb) tb.style.opacity = "0.5";
  
  // Fetch data
  fetchBalances().then(()=>{
     if(tb) tb.style.opacity = "1";
  });
  try{ renderActivity(); }catch(e){}
}
window.setActiveWallet = setActiveWallet;

// Load active index preference
try {
  chrome.storage.local.get({activeWalletIndex:0}, (r)=>{
    if(r && typeof r.activeWalletIndex === 'number') activeWalletIndex = r.activeWalletIndex;
  });
} catch(e){}

// UI helpers
  function setVisible(sel, on){ 
    const el=$(sel); 
    if(!el) return;
    el.classList.toggle("hidden", !on);
    el.style.display = on ? '' : 'none';
    // Use auth-mode class to hide topbar during auth, show otherwise
    if(sel==='#authSection'){
        if(on) document.body.classList.add('auth-mode');
        else document.body.classList.remove('auth-mode');
    }
  }
  function setActiveTab(tab){ $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab===tab)); $$(".tabpane").forEach(p => p.style.display = (p.dataset.pane===tab ? "block":"none")); }

  // WebCrypto vault - Versioned encryption with migration support
  const VAULT_VERSIONS = {
    1: { iterations: 350000 },  // v0.3.0 and earlier
    2: { iterations: 600000 }   // v0.3.1+ (OWASP 2024 recommendation)
  };
  const CURRENT_VAULT_VERSION = 2;

  async function deriveKey(password, salt, iterations = VAULT_VERSIONS[CURRENT_VAULT_VERSION].iterations) {
    const enc = new TextEncoder();
    const mat = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      {name: "PBKDF2", salt, iterations, hash: "SHA-256"},
      mat,
      {name: "AES-GCM", length: 256},
      false,
      ["encrypt", "decrypt"]
    );
  }
  window.deriveKey = deriveKey;
  function toB64(bytes){ return btoa(String.fromCharCode(...bytes)); }
  function fromB64(str){ return new Uint8Array(atob(str).split('').map(c=>c.charCodeAt(0))); }
  window.fromB64 = fromB64;

  async function saveVault(seedBytes, password){
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const iterations = VAULT_VERSIONS[CURRENT_VAULT_VERSION].iterations;
    const key = await deriveKey(password, salt, iterations);
    const ct = new Uint8Array(await crypto.subtle.encrypt({name: "AES-GCM", iv}, key, seedBytes));
    await chrome.runtime.sendMessage({
      type: "QTC_STORE_ENCRYPTED",
      payload: {
        version: CURRENT_VAULT_VERSION,
        iterations: iterations,
        salt: toB64(salt),
        iv: toB64(iv),
        ciphertext: toB64(ct)
      }
    });
    state.cryptoKey = key;
    return key;
  }

  async function loadVault(password){
    const resp = await chrome.runtime.sendMessage({ type: "QTC_LOAD_ENCRYPTED" });
    if(!resp?.payload) throw new Error("Vault not found");
    
    const { salt, iv, ciphertext, version, iterations } = resp.payload;
    
    // Determine iterations: use metadata if exists, otherwise fallback to legacy
    let iters;
    if (typeof iterations === 'number') {
      iters = iterations;
    } else if (typeof version === 'number' && VAULT_VERSIONS[version]) {
      iters = VAULT_VERSIONS[version].iterations;
    } else {
      // Legacy vault without version = v1 (350k iterations)
      iters = VAULT_VERSIONS[1].iterations;
    }
    
    const key = await deriveKey(password, fromB64(salt), iters);
    const decrypted = await crypto.subtle.decrypt(
      {name: "AES-GCM", iv: fromB64(iv)},
      key,
      fromB64(ciphertext)
    );
    
    // Auto-migrate if using old vault format
    if (iters !== VAULT_VERSIONS[CURRENT_VAULT_VERSION].iterations) {
      console.log(`[Vault] Migrating from ${iters} to ${VAULT_VERSIONS[CURRENT_VAULT_VERSION].iterations} iterations`);
      await saveVault(new Uint8Array(decrypted), password);
      // Key is now updated by saveVault
    } else {
      state.cryptoKey = key;
    }
    
    return state.cryptoKey;
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

  // Helper to sync keys (ENCRYPTED)
  async function updateSessionKeys(){
    if(!state.keys || !state.keys.length) return;
    
    // 1. Save to storage.session ENCRYPTED (Robust MV3 memory persistence)
    try {
      // Generate ephemeral key for session encryption
      const sessKey = await makeSessionKey();
      const cryptoKey = await importSessKey(sessKey);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = new TextEncoder().encode(JSON.stringify(state.keys));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv}, cryptoKey, plaintext));
      
      // Get TTL from storage (default 15 min)
      let ttl = 900000;
      try {
        const ttlData = await chrome.storage.local.get({qtcAutolockTTL: 900000});
        ttl = ttlData.qtcAutolockTTL || 900000;
      } catch(e){}
      
      // Calculate expiresAt (0 = never)
      const expiresAt = (ttl === 0) ? 0 : (Date.now() + ttl);
      
      await chrome.storage.session.set({
        qtcTempKeysEnc: {
          key: b64FromBytes(sessKey),
          iv: b64FromBytes(iv),
          ct: b64FromBytes(ciphertext),
          expiresAt: expiresAt
        }
      });
    } catch(e){ /* silent */ }

    // 2. Sync with Offscreen (Keep-alive) - still needs keys for session management
    try {
      const cleanKeys = state.keys.map(k => ({addr: k.addr, wif: k.wif}));
      await new Promise(resolve => {
        chrome.runtime.sendMessage({type:'QTC_SESS_OPEN', keys: cleanKeys}, resolve);
      });
    } catch(e){}
  }

  async function pushKey(addr, wif){ 
    state.keys.push({addr,wif}); 
    renderKeys(); 
    
    // 1. Persist to Encrypted Local Storage
    try { await saveKeysEncrypted(); } catch(e){ notify("Could not save keys","error"); }
    
    // 2. Update Active Session
    await updateSessionKeys();

    // 3. Update Session Envelope (Backup persistence)
    try { await setSessionEnvelope(); } catch(e){}
    
    // 4. Refresh
    fetchBalances().catch(()=>{}); 
  }
  function renderKeys(){
    const _al = document.querySelector("#addrList"); if(_al) _al.innerHTML = state.keys.map((k,i)=>`
      <div class="account-row flex items-center justify-between" data-idx="${i}">
        <div class="truncate">
          <div class="flex items-center gap-2">
            <span class="copyIcon copyAddr" title="Copy" data-addr="${k.addr}" aria-label="Copy">📋</span>
            <div class="font-mono truncate">${k.addr}</div>
          </div>
          <div class="text-xs opacity-70">idx ${i}</div>
        </div>
        <div class="flex items-center gap-3">
          <div class="addrBalance font-mono text-sm" data-addr="${k.addr}">${formatQtc(k.balance || 0)}</div>
          <button class="btn btn-xs" data-action="export-wif" data-idx="${i}">WIF</button>
        </div>
      </div>
    `).join("");
    try {
      const elAct = document.querySelector("#activityList");
      if (elAct && typeof renderActivity === "function") { renderActivity(); }
    } catch(e) { /* noop */ }
    // Update wallet selector
    try { if(typeof updateWalletSelector === 'function') updateWalletSelector(); } catch(e){}
    try { if(typeof renderMainAddressInline === 'function') renderMainAddressInline(); } catch(e){}
  }

  async function exportWIF(){
    if(!state.keys.length) return notify("No keys yet","error");
    try{ await navigator.clipboard.writeText(state.keys[state.keys.length-1].wif); notify("WIF copied","success"); }catch(e){ notify("Could not copy","error"); }
  }

  function generateAddress(){
    if(!detectCoinjs()) return notify("coinjs not available","error");
    try{
      const r = coinjs.newKeys();
      pushKey(r.address, r.wif);
      return r;
    }catch(e){ console.error(e); notify("Error generating address: "+e.message,"error"); }
  }
  window.generateAddress = generateAddress;

  function updatePendingChips(inAmt, inCount, outAmt, outCount){
    try{
      const inc = document.getElementById('chipIncoming');
      const out = document.getElementById('chipOutgoing');
      
      if(inc){
        if(inAmt > 0 || inCount > 0){
          inc.textContent = `+${inAmt.toFixed(8)} (${inCount})`;
          inc.classList.remove('hidden'); inc.setAttribute('aria-hidden','false');
        } else {
          inc.classList.add('hidden'); inc.setAttribute('aria-hidden','true');
        }
      }
      if(out){
        if(outAmt > 0 || outCount > 0){
          out.textContent = `-${outAmt.toFixed(8)} (${outCount})`;
          out.classList.remove('hidden'); out.setAttribute('aria-hidden','false');
        } else {
          out.classList.add('hidden'); out.setAttribute('aria-hidden','true');
        }
      }
    }catch(e){ /* silent */ }
  }
  function resetPendingChips(){ updatePendingChips(0,0,0,0); }

  // API endpoint
  const API = 'https://explorer-api.superquantum.io';
  
  async function fetchAPI(path, options = {}) {
    return fetch(`${API}${path}`, options);
  }
  
  window.fetchAPI = fetchAPI;

  async function pendingIncomingViaUtxo(addrs){
    let sum=0, cnt=0;
    for(const a of addrs){
      try{
        const url = `/address/${encodeURIComponent(a)}/utxo`;
        const r = await fetchAPI(url); const arr = await r.json();
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
          const url = `/address/${encodeURIComponent(a)}/utxo?t=${Date.now()}`;
          const r = await fetchAPI(url); const arr = await r.json();
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
          const r = await fetchAPI(`/tx/${encodeURIComponent(u.txid)}`);
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
        const url = `/address/${encodeURIComponent(a)}/txs/mempool?t=${Date.now()}`;
        const r = await fetchAPI(url); const txs = await r.json();
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
      const k = (state.keys||[])[window.activeWalletIndex] || (state.keys||[])[0];
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
      // Check keys
      if(!state.keys || !state.keys.length){
        const t=$("#totalBalance"); if(t) t.textContent="0";
        renderMainAddressInline();
        const totals = $("#totals"); if (totals) totals.style.display="block";
        try{ updatePendingChips(0,0,0,0); }catch(e){}
        return;
      }
      
      // Only fetch active wallet
      const activeKey = state.keys[window.activeWalletIndex] || state.keys[0];
      const addrs = [activeKey.addr]; 
      
      let total = 0; let incSum=0, outSum=0, incCnt=0, outCnt=0;
      for(const a of addrs){
        const url = `/address/${encodeURIComponent(a)}?t=${Date.now()}`;
        const res = await fetchAPI(url); const j = await res.json();
        let sats = 0;
        if (j && j.chain_stats){ sats += (j.chain_stats.funded_txo_sum||0) - (j.chain_stats.spent_txo_sum||0); }
        const coin = sats/1e8;
        if(j && j.mempool_stats){
          incSum += (j.mempool_stats.funded_txo_sum||0)/1e8;  incCnt += (j.mempool_stats.funded_txo_count||0);
          outSum += (j.mempool_stats.spent_txo_sum||0)/1e8;   outCnt += (j.mempool_stats.spent_txo_count||0);
        }
        total += coin;
        // Update active key balance in state
        if(activeKey.addr === a) activeKey.balance = coin;
      }
      
      window.__qtcTotal = total;
      const tb = $("#totalBalance");
      if (tb) tb.textContent = (Math.abs(total) < 1e-12) ? '0' : total.toFixed(8);
      try{ window.__qtcTotal = total; __recalcTopFiatFromDom(); }catch(_){ } 
      renderMainAddressInline();
      const totals = $("#totals"); if (totals) totals.style.display="block";
      try{ updatePendingChips(incSum, incCnt, outSum, outCnt); }catch(e){}
      
    }catch(e){ console.warn(e); notify("Could not fetch balance","error"); }

    // Unconfirmed net line
    try {
      const activeKey = state.keys[window.activeWalletIndex] || state.keys[0];
      const addrs = [activeKey.addr];
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
    const pwd=$("#password").value; 
    if(!pwd) return notify("Enter your password","error");
    try{
      await loadVault(pwd);
    }catch(e){ 
      return notify("Wrong password","error"); 
    }
    // Password correct, proceed
    try { await setSessionEnvelope(); } catch(e){}
    try { startSessKeepAlive(); } catch(e){}
    state.unlocked=true;
    try { detectCoinjs(); } catch(e){}
    try { await loadKeysEncrypted(); } catch(e){}
    try { populateFromSelect(); } catch(e){}
    // Show wallet
    setVisible("#authSection", false); 
    setVisible("#walletSection", true);
    try { await fetchBalances(); } catch(e){}
    // Ensure session is synced
    updateSessionKeys();
    notify("Vault unlocked","success");
  }
  async function createVault(){
    const pwd=$("#password").value; if(!pwd) return notify("Create a password","error");
    const seed=crypto.getRandomValues(new Uint8Array(32));
    await saveVault(seed, pwd);

    detectCoinjs();
    let first=null; try{ first = generateAddress(); }catch(e){ console.error(e); }
    state.keys = state.keys || [];
    await saveKeysEncrypted();
    await updateSessionKeys();

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
          try{ await navigator.clipboard.writeText(wifEl.value||""); notify("WIF copied","success"); }
          catch(e){ notify("Could not copy","error"); }
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
          try{ await loadKeysEncrypted(); populateFromSelect(); await fetchBalances(); }catch(e){}
          notify("Wallet created","success");
          const cb=document.querySelector("#createBtn"); if(cb) cb.style.display="none";
          try{
            if (window.QTC_gate) { window.QTC_gate(); }
            else {
              setVisible("#authSection", false);
              setVisible("#walletSection", true);
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
    notify("Wallet created","success");
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
      if(pwdHint) pwdHint.textContent = "We'll use this password to encrypt your local vault. It's not recoverable if you forget it.";
      if(unlockBtn) unlockBtn.style.display = 'none';
      if(createBtn){ createBtn.style.display=''; createBtn.textContent='Create wallet'; }
      const cta=document.getElementById('importWifCta'); if(cta) cta.style.display='';
    }else{
      if(title) title.textContent = 'Unlock';
      if(pwdLabel) pwdLabel.textContent = 'Password';
      if(pwdHint) pwdHint.textContent = '';
      if(unlockBtn) unlockBtn.style.display = '';
      const cta=document.getElementById('importWifCta'); if(cta) cta.style.display='none';
      if(createBtn){ createBtn.style.display='none'; }
    }
  }
  window.setAuthMode = setAuthMode;

  async function startImportWifFlow(){
    const modal = document.getElementById('importWifModal');
    const input = document.getElementById('importWifInput');
    const cancelBtn = document.getElementById('cancelImportWifBtn');
    const confirmBtn = document.getElementById('confirmImportWifBtn');
    if(!modal || !input || !cancelBtn || !confirmBtn){ return notify('Could not open importer', 'error'); }

    modal.classList.remove('hidden'); modal.style.display='flex'; modal.setAttribute('aria-hidden','false');
    input.value='';

    const closeModal = ()=>{ modal.classList.add('hidden'); modal.style.display='none'; modal.setAttribute('aria-hidden','true'); };
    if(!cancelBtn.dataset.bound){ cancelBtn.dataset.bound='1'; cancelBtn.addEventListener('click', closeModal); }

    if(!confirmBtn.dataset.bound){
      confirmBtn.dataset.bound='1';
      confirmBtn.addEventListener('click', async ()=>{
        try{
          const wif = (input.value||'').trim();
          if(!wif) return notify('Paste your WIF', 'error');
          // Initialize vault if needed using the password field
          if(!state.cryptoKey){
            const pwdInput = document.getElementById('password');
            const pwd = (pwdInput && pwdInput.value) ? pwdInput.value : '';
            if(!pwd){
              return notify('Set a password above first to encrypt your vault, then import your WIF.', 'error');
            }
            try{
              const seed = crypto.getRandomValues(new Uint8Array(32));
              await saveVault(seed, pwd);
            }catch(err){
              console.error(err);
              return notify('Could not create vault', 'error');
            }
          }
          detectCoinjs();
          let addr='';
          try{
            if(typeof coinjs.wif2address === 'function'){ addr = (coinjs.wif2address(wif)||{}).address || ""; }
          }catch(e){}
          if(!addr){ return notify('Invalid WIF', 'error'); }
          pushKey(addr, wif);
          try{ await saveKeysEncrypted(); }catch(_){}
          notify('WIF imported', 'success');
          closeModal();
          
          state.unlocked = true;
          setVisible('#authSection', false);
          setVisible('#walletSection', true);
          try{ await setSessionEnvelope(); startSessKeepAlive(); }catch(e){}
          try{ await loadKeysEncrypted(); populateFromSelect(); await fetchBalances(); }catch(e){}
          try{ const cb=document.querySelector('#createBtn'); if(cb && await hasVault()) cb.style.display='none'; }catch(_){}
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
        try { await easySend(); } catch(e){ try{ notify(e.message||'Send error','error'); }catch(_){} }
      });
    }

    // Fee selector logic
    const feeBtns = document.querySelectorAll('.fee-btn');
    const feeInput = document.getElementById('easyFee');
    
    feeBtns.forEach(btn => {
      if(btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        feeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if(feeInput) feeInput.value = btn.dataset.fee;
      });
    });
    
    if(feeInput && !feeInput.dataset.bound){
      feeInput.dataset.bound = '1';
      feeInput.addEventListener('input', () => {
        const val = parseInt(feeInput.value, 10);
        feeBtns.forEach(b => {
          b.classList.toggle('active', parseInt(b.dataset.fee, 10) === val);
        });
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

  document.addEventListener("DOMContentLoaded", async ()=>{ 
    try{ startAutoRefresh(); }catch(e){}
    try{ setAuthMode("create"); }catch(e){}
    bindUI(); populateFromSelect(); try{ setAuthMode("create"); }catch(e){}

    // === Session Recovery Strategy ===
    if(!state.unlocked){
        let recovered = false;
        
        // 1. Try fast storage.session (decrypted buffer)
        if(await tryRestoreFromStorageSession()){
           recovered = true;
        } 
        // 2. Try envelope storage.session (encrypted buffer)
        else {
            try {
              if(await tryRestoreEnvelope()) recovered = true;
            } catch(e){}
        }

        if(recovered){
           state.unlocked = true;
           document.body.classList.remove('auth-mode');
           setVisible("#authSection", false);
           setVisible("#walletSection", true);
           detectCoinjs();
           
           // Load and set active wallet
           let savedIdx = 0;
           try {
             const st = await chrome.storage.local.get({activeWalletIndex:0});
             if(st && typeof st.activeWalletIndex === 'number') savedIdx = st.activeWalletIndex;
           } catch(e){}

           setActiveWallet(savedIdx);
           renderKeys();
           // Sync offscreen just in case
           updateSessionKeys();
        }
    }

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
  const url = `/tx/${txid}`;
  const r = await fetchAPI(url);
  if(!r.ok) throw new Error(`tx ${txid} ${r.status}`);
  const j = await r.json();
  if(!j || !Array.isArray(j.vout) || !j.vout[vout]) throw new Error("tx vout missing");
  return j.vout[vout].scriptpubkey;
}

async function fetchUTXOsEsplora(address){
  const url = `/address/${encodeURIComponent(address)}/utxo`;
  const r = await fetchAPI(url);
  if(!r.ok) throw new Error(`UTXO fetch ${r.status}`);
  return await r.json(); 
}

function reverseHex(h){ return (h||'').match(/.{1,2}/g).reverse().join(''); }
function estimateVSize(numIn, numOut){
  return Math.ceil(148*numIn + 34*numOut + 10);
}

async function buildAndSignTx(fromIdx, toAddress, amountQtc, feeSatPerByte){
  if (!coinjs || !coinjs.transaction) throw new Error("coinjs not available");
  const from = state.keys[fromIdx]; if(!from) throw new Error("invalid origin");

  // Fetch UTXOs using our fetchAPI instead of coinjs.ajax
  const utxoUrl = `/address/${encodeURIComponent(from.addr)}/utxo`;
  const utxoRes = await fetchAPI(utxoUrl);
  if(!utxoRes.ok) throw new Error(`UTXO fetch failed: ${utxoRes.status}`);
  const utxos = await utxoRes.json();
  
  if(!Array.isArray(utxos) || utxos.length === 0){
    throw new Error("No unspent outputs found");
  }
  
  // Filter only confirmed UTXOs for sending
  const confirmedUtxos = utxos.filter(u => u.status && u.status.confirmed);
  if(confirmedUtxos.length === 0){
    throw new Error("No confirmed UTXOs available");
  }
  
  // Build transaction
  const tx = coinjs.transaction();
  tx.version = 2;
  
  let totalValue = 0;
  for(const u of confirmedUtxos){
    const s = coinjs.script();
    s.spendToScript(from.addr);
    tx.addinput(u.txid, u.vout, Crypto.util.bytesToHex(s.buffer), 0xffffffff);
    totalValue += u.value;
  }
  
  const nIn = confirmedUtxos.length;
  const nOut = 2;
  const vsize = Math.ceil(148*nIn + 34*nOut + 10);
  const feeSat = Math.ceil(vsize * feeSatPerByte);
  const feeQTC = feeSat / 1e8;
  
  const totalQTC = totalValue / 1e8;
  const changeQTC = totalQTC - amountQtc - feeQTC;
  if(changeQTC < 0) throw new Error("Insufficient funds");
  
  tx.addoutput(toAddress, Number(amountQtc).toFixed(8));
  if(changeQTC > 0.00000546) tx.addoutput(from.addr, Number(changeQTC).toFixed(8));
  
  // Sign transaction
  const tx2 = coinjs.transaction();
  const txu = tx2.deserialize(tx.serialize());
  txu.version = 2;
  
  for(let i = 0; i < txu.ins.length; i++){
    const tmp = coinjs.transaction();
    const tmpu = tmp.deserialize(txu.serialize());
    for(let j = 0; j < tmpu.ins.length; j++){ tmpu.ins[j].script = coinjs.script(); }
    tmpu.ins[i].script = coinjs.script().spendToScript(from.addr);
    const sighex = tmpu.transactionSig(i, from.wif, 1);
    const pub = coinjs.wif2pubkey(from.wif).pubkey;
    const sc = coinjs.script();
    sc.writeBytes(Crypto.util.hexToBytes(sighex));
    sc.writeBytes(Crypto.util.hexToBytes(pub));
    txu.ins[i].script = sc;
  }
  
  const hex = txu.serialize();
  if(!hex || typeof hex !== 'string') throw new Error("Signing failed");
  
  return hex;
}

// Store pending transaction data for confirmation
let __pendingSend = null;

// Validate QTC address format
function isValidQtcAddress(addr){
  if(!addr || typeof addr !== 'string') return false;
  // Use coinjs validation if available
  if(typeof coinjs !== 'undefined' && typeof coinjs.addressDecode === 'function'){
    try {
      const decoded = coinjs.addressDecode(addr);
      // Valid if decoded and has correct version (0x00 for P2PKH, 0x05 for P2SH)
      if(decoded && (decoded.version === coinjs.pub || decoded.version === coinjs.multisig || decoded.type === 'bech32')){
        return true;
      }
      return false;
    } catch(e){ return false; }
  }
  // Fallback: basic format check (Base58 chars, length 25-35)
  if(!/^[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(addr)) return false;
  return true;
}

// Show confirmation modal before sending
async function easySend(){
  try{
    // Use active wallet index
    const idx = window.activeWalletIndex || 0;
    const to = (document.querySelector('#easyTo').value||"").trim();
    const amt = Number(document.querySelector('#easyAmount').value||"0");
    const fee = Number(document.querySelector('#easyFee').value||"5");
    
    if(!to) throw new Error("Recipient is required");
    
    // SECURITY: Validate destination address
    if(!isValidQtcAddress(to)){
      throw new Error("Invalid QTC address format");
    }
    
    if(!amt || amt<=0) throw new Error("Invalid amount");
    if(!fee || fee<=0) throw new Error("Invalid fee");
    
    // Store data and show confirmation modal
    __pendingSend = { idx, to, amt, fee };
    
    // Populate modal
    const modal = document.getElementById('confirmSendModal');
    document.getElementById('confirmTo').textContent = to;
    document.getElementById('confirmTo').title = to;
    document.getElementById('confirmAmount').textContent = amt.toFixed(8) + ' QTC';
    document.getElementById('confirmFee').textContent = fee + ' sats/byte';
    
    // Show modal
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
  }catch(e){
    notify(String(e), "error"); 
  }
}

// Actually execute the send after confirmation
async function executeConfirmedSend(){
  const outEl = document.querySelector('#easySendOut');
  const showOut = (msg) => { 
    if(outEl){ 
      if(msg){ outEl.textContent = msg; outEl.style.display = 'block'; } 
      else { outEl.textContent = ''; outEl.style.display = 'none'; }
    } 
  };
  
  // Close modal
  const modal = document.getElementById('confirmSendModal');
  modal.classList.add('hidden');
  modal.style.display = 'none';
  modal.setAttribute('aria-hidden', 'true');
  
  if(!__pendingSend) return;
  const { idx, to, amt, fee } = __pendingSend;
  __pendingSend = null;
  
  try{
    showOut('Signing transaction…');
    const hex = await buildAndSignTx(idx, to, amt, fee);
    if (!(typeof hex==='string' && hex.length>=200 && /^[0-9a-fA-F]+$/.test(hex))) {  
      showOut('Invalid TX'); notify('Invalid TX','error');
      try{ await fetchBalances(); setTimeout(()=>{ try{ fetchBalances(); }catch(e){} }, 1500); }catch(e){}
      return;
    }
    try{ var txArea=document.querySelector('#rawtx'); if(txArea){ txArea.value = hex; } }catch(e){}
    showOut('Broadcasting…');
    // broadcast via SW
    const res=await chrome.runtime.sendMessage({ type:"QTC_BROADCAST", rawtx:hex });
    const msg = (res && res.ok) ? 'Transaction sent!' : ('Send error: ' + ((res&& (res.error||res.status)) || 'unknown'));
    showOut(msg);
    notify(res.ok ? "Transaction sent" : ("Broadcast error: "+(res.error||res.status)), res.ok ? "success":"error");
    // Auto-hide after success
    if(res && res.ok){ 
      // Clear form
      try{ document.querySelector('#easyTo').value = ''; document.querySelector('#easyAmount').value = ''; }catch(e){}
      setTimeout(()=> showOut(''), 5000); 
    }
  }catch(e){
    showOut(String(e));
    notify(String(e), "error"); 
  }
}

// Cancel send
function cancelSend(){
  __pendingSend = null;
  const modal = document.getElementById('confirmSendModal');
  modal.classList.add('hidden');
  modal.style.display = 'none';
  modal.setAttribute('aria-hidden', 'true');
}

// Wire up confirm modal buttons
document.addEventListener('DOMContentLoaded', ()=>{
  const confirmBtn = document.getElementById('confirmSendBtn');
  const cancelBtn = document.getElementById('cancelSendBtn');
  if(confirmBtn && !confirmBtn.dataset.bound){
    confirmBtn.dataset.bound = '1';
    confirmBtn.addEventListener('click', executeConfirmedSend);
  }
  if(cancelBtn && !cancelBtn.dataset.bound){
    cancelBtn.dataset.bound = '1';
    cancelBtn.addEventListener('click', cancelSend);
  }
});

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
    navigator.clipboard.writeText(k.wif).then(()=>notify("WIF copied to clipboard","success")) :
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
      }catch(err){ notify('Could not copy','error'); }
    }
  });
})();

async function renderActivity(){
  try{
    const cont = document.querySelector("#activityList");
    if(!cont) return;
    const keys = (window.state && Array.isArray(state.keys)) ? state.keys : [];
    const k = keys[window.activeWalletIndex] || keys[0];
    if(!k){ cont.innerHTML = '<div class="muted">No addresses yet.</div>'; return; }

    cont.innerHTML = '<div class="muted">Loading activity…</div>';

    const WEB = 'https://explorer.qverse.pro';
    const addr = encodeURIComponent(k.addr);

    // Use official API for history data
    const ESPLORA = 'https://explorer-api.superquantum.io';
    Promise.allSettled([
      fetch(`${ESPLORA}/address/${addr}/txs/mempool`),
      fetch(`${ESPLORA}/address/${addr}/txs`)
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
        const txURL = `${WEB}/txs/${encodeURIComponent(tx.txid)}`;
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
      cont.innerHTML = '<div class="muted">Could not load activity.</div>';
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
    const fmtUSD = (v)=>{ const n = Number(v||0); return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(6)}`; };
    if (elFiat) elFiat.textContent = fmtUSD(total * (price||0));
    if (elCh){
      const sign = ch24>0 ? 'pos' : (ch24<0 ? 'neg' : 'neutral');
      elCh.className = `change ${sign}`;
      elCh.textContent = (ch24>0?'+':'') + (isFinite(ch24)?ch24.toFixed(2):'0.00') + '%';
    }
  }catch(e){}
}

(function(){
  // CoinEx API v2 - Public endpoints (no auth required)
  const API_TICKER = 'https://api.coinex.com/v2/spot/ticker?market=QTCUSDT';
  const API_KLINE = (period, limit) => `https://api.coinex.com/v2/spot/kline?market=QTCUSDT&period=${period}&limit=${limit}`;
  const CACHE_KEY = 'qtcPriceCache';
  
  // Map days to CoinEx period and limit
  function getKlineParams(days) {
    if (days <= 1) return { period: '1hour', limit: 24 };
    if (days <= 7) return { period: '4hour', limit: 42 };
    return { period: '1day', limit: 30 };
  }
  
  let lastDays = 1;
  let lastTs = 0;
  let cacheLoaded = false;

  function fmtUSD(v){ 
    const n = Number(v||0);
    return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(6)}`;
  }
  
  async function loadCachedPrice(){
    if(cacheLoaded) return;
    cacheLoaded = true;
    try {
      const data = await chrome.storage.local.get({ [CACHE_KEY]: null });
      const cache = data[CACHE_KEY];
      if(cache){
        const elPrice = document.getElementById('qtcPrice');
        const elChange = document.getElementById('qtcChange');
        if(elPrice && cache.price) elPrice.textContent = fmtUSD(cache.price);
        if(elChange && typeof cache.change === 'number'){
          const sign = cache.change > 0 ? 'pos' : (cache.change < 0 ? 'neg' : 'neutral');
          elChange.className = `change ${sign}`;
          elChange.textContent = (cache.change > 0 ? '+' : '') + cache.change.toFixed(2) + '%';
        }
        if(cache.chart) drawSpark(cache.chart);
        try{ window.__lastPrice = cache.price; window.__lastChange = cache.change; }catch(_){}
      }
    } catch(e){}
  }
  
  async function saveCache(price, change, chart){
    try {
      await chrome.storage.local.set({ [CACHE_KEY]: { price, change, chart } });
    } catch(e){}
  }

  function drawSpark(values){
    try{
      const c = document.getElementById('qtcSpark');
      if(!c) return;
      const ctx = c.getContext('2d');
      const w=c.width, h=c.height;
      ctx.clearRect(0,0,w,h);
      if(!values || !values.length) return;
      // CoinEx kline returns objects with 'close' price
      const ys = values.map(p => parseFloat(p.close || p[1] || 0));
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
        values: values.map((p,i) => [i, parseFloat(p.close || p[1] || 0)]),
        min: min, max: max, n: ys.length,
        pad: pad, w: c.width, h: c.height
      };
    }catch(e){ /* noop */ }
  }

  let lastChartData = null;
  
  async function loadDetail(){
    const elPrice = document.getElementById('qtcPrice');
    const elChange = document.getElementById('qtcChange');
    const elUpdated = document.getElementById('qtcUpdated');
    try{
      const r = await fetch(API_TICKER);
      const j = await r.json();
      if(j.code !== 0 || !j.data || !j.data.length) throw new Error('No data');
      const ticker = j.data[0];
      const price = parseFloat(ticker.last);
      const open = parseFloat(ticker.open);
      const ch24 = open > 0 ? ((price - open) / open) * 100 : 0;
      
      if(!isNaN(price)){
        elPrice.textContent = fmtUSD(price);
      }
      if(!isNaN(ch24)){
        const sign = ch24 > 0 ? 'pos' : (ch24 < 0 ? 'neg' : 'neutral');
        elChange.className = `change ${sign}`;
        elChange.textContent = (ch24 > 0 ? '+' : '') + ch24.toFixed(2) + '%';
      }
      try{ window.__lastPrice = price; window.__lastChange = ch24; __recalcTopFiatFromDom(); }catch(_){ }
      elUpdated.textContent = ''; try{ elUpdated.style.display='none'; }catch(_){}
      // Save to cache
      saveCache(price, ch24, lastChartData);
    }catch(e){
      elUpdated.textContent = ''; try{ elUpdated.style.display='none'; }catch(_){}
    }
  }

  async function loadChart(days){
    try{
      const { period, limit } = getKlineParams(days);
      const r = await fetch(API_KLINE(period, limit));
      const j = await r.json();
      if(j.code !== 0 || !j.data) throw new Error('No data');
      const arr = j.data || [];
      lastChartData = arr;
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
   
    // Load cached data first (instant), then fetch fresh data
    loadCachedPrice();
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

// Settings Dropdown Menu
(function(){
  const AUTOLOCK_KEY = 'qtcAutolockTTL';
  const DEFAULT_TTL = 900000; // 15 min
  
  async function loadAutolockSetting(){
    try {
      const data = await chrome.storage.local.get({ [AUTOLOCK_KEY]: DEFAULT_TTL });
      return data[AUTOLOCK_KEY];
    } catch(e){ return DEFAULT_TTL; }
  }
  
  async function saveAutolockSetting(ttl){
    try {
      await chrome.storage.local.set({ [AUTOLOCK_KEY]: ttl });
      // Notify offscreen about new TTL
      chrome.runtime.sendMessage({ type: 'QTC_SESS_SET_TTL', ttl: ttl }, () => {
        if(chrome.runtime.lastError){ /* ignore */ }
      });
    } catch(e){}
  }
  
  function initSettingsDropdown(){
    const btn = document.getElementById('settingsBtn');
    const menu = document.getElementById('settingsMenu');
    const menuNewAddr = document.getElementById('menuNewAddress');
    const menuExportWIF = document.getElementById('menuExportWIF');
    const menuLock = document.getElementById('menuLock');
    const autolockSelect = document.getElementById('autolockSelect');
    
    if(!btn || !menu) return;
    if(btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    
    // Load and set autolock preference
    if(autolockSelect){
      loadAutolockSetting().then(ttl => {
        autolockSelect.value = String(ttl);
      });
      autolockSelect.addEventListener('change', (e) => {
        const ttl = parseInt(e.target.value, 10);
        saveAutolockSetting(ttl);
      });
      // Prevent dropdown from closing when clicking select
      autolockSelect.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }
    
    // Toggle dropdown
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      // Close wallet selector if open
      const walletSelector = document.getElementById('walletSelector');
      const walletMenu = document.getElementById('walletSelectorMenu');
      if(walletSelector) walletSelector.classList.remove('open');
      if(walletMenu) walletMenu.classList.add('hidden');
      // Toggle settings menu
      menu.classList.toggle('show');
    });
    
    // Close on click outside
    document.addEventListener('click', (e)=>{
      if(!e.target.closest('.settings-dropdown')){
        menu.classList.remove('show');
      }
    });
    
    // New Address - Open modal with result
    if(menuNewAddr){
      menuNewAddr.addEventListener('click', ()=>{
        menu.classList.remove('show');
        openNewAddressModal();
      });
    }
    
    // Export WIF - Open modal
    if(menuExportWIF){
      menuExportWIF.addEventListener('click', ()=>{
        menu.classList.remove('show');
        openExportWifModal();
      });
    }
    
    // Lock Wallet
    if(menuLock){
      menuLock.addEventListener('click', async ()=>{
        menu.classList.remove('show');
        try {
          // Clear session state
          if(window.state){
            state.unlocked = false;
            state.cryptoKey = null;
            state.keys = [];
          }
          // Clear ALL session data
          try { await chrome.storage.session.clear(); } catch(e){}
          try { 
            await new Promise((resolve) => {
              chrome.runtime.sendMessage({type:'QTC_SESS_CLEAR'}, () => {
                if (chrome.runtime.lastError) { /* ignore */ }
                resolve();
              });
            });
          } catch(e){}
          try { if(typeof clearEnvelope === 'function') await clearEnvelope(); } catch(e){}
          // Show auth, hide wallet
          document.body.classList.add('auth-mode');
          const auth = document.getElementById('authSection');
          const wallet = document.getElementById('walletSection');
          if(auth){ auth.classList.remove('hidden'); auth.style.display = ''; }
          if(wallet){ wallet.classList.add('hidden'); wallet.style.display = 'none'; }
          // Reset auth UI to unlock mode
          if(typeof window.setAuthMode === 'function') window.setAuthMode('unlock');
          // Clear password field
          const pwd = document.getElementById('password');
          if(pwd) pwd.value = '';
          notify('Wallet locked', 'success');
        } catch(e){
          notify('Error locking wallet', 'error');
        }
      });
    }
  }
  
  if(document.readyState==='loading'){ 
    document.addEventListener('DOMContentLoaded', initSettingsDropdown); 
  } else { 
    initSettingsDropdown(); 
  }
})();

// Export WIF Modal Logic
function openExportWifModal(){
  const modal = document.getElementById('exportWifModal');
  const pwdField = document.getElementById('exportWifPasswordField');
  const resultField = document.getElementById('exportWifResultField');
  const pwdInput = document.getElementById('exportWifPassword');
  const resultInput = document.getElementById('exportWifResult');
  const cancelBtn = document.getElementById('cancelExportWifBtn');
  const confirmBtn = document.getElementById('confirmExportWifBtn');
  const copyBtn = document.getElementById('copyExportWifBtn');
  const title = document.getElementById('exportWifTitle');
  const desc = document.getElementById('exportWifDesc');
  
  if(!modal) return;
  
  // Reset modal state
  pwdField.style.display = '';
  resultField.style.display = 'none';
  confirmBtn.style.display = '';
  copyBtn.style.display = 'none';
  pwdInput.value = '';
  resultInput.value = '';
  title.textContent = 'Export Private Key';
  desc.textContent = 'Enter your password to reveal your private key (WIF).';
  
  // Show modal
  modal.classList.remove('hidden');
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
  pwdInput.focus();
  
  const closeModal = ()=>{
    modal.classList.add('hidden');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    pwdInput.value = '';
    resultInput.value = '';
  };
  
  // Cancel button
  if(!cancelBtn.dataset.bound){
    cancelBtn.dataset.bound = '1';
    cancelBtn.addEventListener('click', closeModal);
  }
  
  // Confirm button - verify password and show WIF
  if(!confirmBtn.dataset.bound){
    confirmBtn.dataset.bound = '1';
    confirmBtn.addEventListener('click', async ()=>{
      const pwd = pwdInput.value;
      if(!pwd){
        notify('Enter your password', 'error');
        return;
      }
      
      try {
        // Verify password by trying to decrypt vault (with legacy support)
        const resp = await chrome.runtime.sendMessage({ type:"QTC_LOAD_ENCRYPTED" });
        if(!resp?.payload) throw new Error("Vault not found");
        
        const {salt, iv, ciphertext, version, iterations} = resp.payload;
        
        // Determine iterations for legacy vault support
        let iters;
        if (typeof iterations === 'number') {
          iters = iterations;
        } else if (typeof version === 'number') {
          iters = version === 1 ? 350000 : 600000;
        } else {
          iters = 350000; // Legacy vault without version
        }
        
        const key = await window.deriveKey(pwd, window.fromB64(salt), iters);
        
        // Try to decrypt - will throw if password wrong
        await crypto.subtle.decrypt({name:"AES-GCM", iv: window.fromB64(iv)}, key, window.fromB64(ciphertext));
        
        // Password correct - get WIF from ACTIVE wallet (not always first)
        const keys = (window.getKeys && typeof window.getKeys === 'function') ? window.getKeys() : [];
        if(!keys.length){
          notify('No keys found', 'error');
          return;
        }
        
        // Use active wallet index, fallback to 0
        const activeIdx = window.activeWalletIndex || 0;
        const activeKey = keys[activeIdx] || keys[0];
        const wif = activeKey?.wif;
        if(!wif){
          notify('WIF not found', 'error');
          return;
        }
        
        // Show WIF with wallet indicator
        pwdField.style.display = 'none';
        resultField.style.display = '';
        confirmBtn.style.display = 'none';
        copyBtn.style.display = '';
        resultInput.value = wif;
        title.textContent = `Private Key (Wallet ${activeIdx + 1})`;
        desc.textContent = 'This is your private key. Keep it safe!';
        
      } catch(e){
        console.error('Export WIF error:', e);
        notify('Wrong password', 'error');
      }
    });
  }
  
  // Copy button
  if(!copyBtn.dataset.bound){
    copyBtn.dataset.bound = '1';
    copyBtn.addEventListener('click', async ()=>{
      const wif = resultInput.value;
      if(wif){
        try {
          await navigator.clipboard.writeText(wif);
          notify('Private key copied', 'success');
        } catch(e){
          notify('Could not copy', 'error');
        }
      }
      closeModal();
    });
  }
}

// Wallet Selector Logic
function initWalletSelector(){
  const btn = document.getElementById('walletSelectorBtn');
  const menu = document.getElementById('walletSelectorMenu');
  const selector = document.getElementById('walletSelector');
  
  if(!btn || !menu) return;
  
  // Toggle menu
  btn.addEventListener('click', (e)=>{
    e.stopPropagation();
    // Close settings dropdown if open
    const settingsMenu = document.getElementById('settingsMenu');
    if(settingsMenu) settingsMenu.classList.remove('show');
    // Toggle wallet selector
    selector.classList.toggle('open');
    menu.classList.toggle('hidden');
  });
  
  // Close on click outside
  document.addEventListener('click', (e)=>{
    if(!e.target.closest('.wallet-selector')){
      selector.classList.remove('open');
      menu.classList.add('hidden');
    }
  });
}

function updateWalletSelector(){
  const menu = document.getElementById('walletSelectorMenu');
  const label = document.getElementById('walletSelectorLabel');
  const selector = document.getElementById('walletSelector');
  
  if(!menu || !label) return;
  
  const keys = (window.state && Array.isArray(state.keys)) ? state.keys : [];
  
  if(keys.length === 0){
    label.textContent = 'No wallets';
    menu.innerHTML = '<div class="wallet-selector-item" style="opacity:.5;cursor:default;">No wallets available</div>';
    return;
  }
  
  // Ensure activeWalletIndex is valid number
  let currentIdx = parseInt(window.activeWalletIndex, 10);
  if(isNaN(currentIdx)) currentIdx = 0;
  // Removed auto-reset to 0 if out of bounds to prevent UI flickering during loading states
  
  // Update label immediately
  label.textContent = `Wallet ${currentIdx + 1}`;
  
  // Populate menu
  menu.innerHTML = keys.map((k, i) => {
    const shortAddr = k.addr ? k.addr.slice(0,8) + '...' + k.addr.slice(-6) : '???';
    const isActive = i === currentIdx;
    // Add a checkmark for active item
    const check = isActive ? '<span style="color:#4ade80;margin-right:8px;">✓</span>' : '<span style="width:18px;display:inline-block;"></span>';
    
    return `<button class="wallet-selector-item${isActive ? ' active' : ''}" data-index="${i}">
      <div style="display:flex;align-items:center;">
        ${check}
        <span>Wallet ${i + 1}</span>
      </div>
      <span class="wallet-addr">${shortAddr}</span>
    </button>`;
  }).join('');
  
  // Add click handlers
  menu.querySelectorAll('.wallet-selector-item').forEach(item => {
    item.addEventListener('click', (e)=>{
      e.stopPropagation(); 
      const idx = parseInt(item.dataset.index, 10);
      if(!isNaN(idx)){
        setActiveWallet(idx);
        selector.classList.remove('open');
        menu.classList.add('hidden');
      }
    });
  });
}

// Removed redundant updateMainAddress
// window.updateMainAddress = updateMainAddress; 
window.updateWalletSelector = updateWalletSelector;

// Initialize wallet selector on load
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', initWalletSelector);
} else {
  initWalletSelector();
}

// New Address Modal Logic
function openNewAddressModal(){
  const modal = document.getElementById('newAddressModal');
  const addrInput = document.getElementById('newAddrAddress');
  const wifInput = document.getElementById('newAddrWif');
  const copyAddrBtn = document.getElementById('copyNewAddr');
  const copyWifBtn = document.getElementById('copyNewWif');
  const closeBtn = document.getElementById('closeNewAddrBtn');
  
  if(!modal) return;
  
  // Generate new address
  if(typeof generateAddress !== 'function'){
    notify('Function not available', 'error');
    return;
  }
  
  let newKey;
  try {
    newKey = generateAddress();
    if(!newKey || !newKey.address || !newKey.wif){
      notify('Error creating address', 'error');
      return;
    }
  } catch(e){
    notify('Error creating address: ' + e.message, 'error');
    return;
  }
  
  // Show modal with new address
  addrInput.value = newKey.address;
  wifInput.value = newKey.wif;
  
  modal.classList.remove('hidden');
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
  
  const closeModal = async ()=>{
    modal.classList.add('hidden');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    // Save keys and refresh
    try { 
      if(typeof saveKeysEncrypted === 'function') await saveKeysEncrypted(); 
    } catch(e){}
    try { 
      if(typeof renderKeys === 'function') renderKeys(); 
    } catch(e){}
    try { 
      if(typeof fetchBalances === 'function') await fetchBalances(); 
    } catch(e){}
    try {
      if(typeof populateFromSelect === 'function') populateFromSelect();
    } catch(e){}
  };
  
  // Copy Address
  if(!copyAddrBtn.dataset.bound){
    copyAddrBtn.dataset.bound = '1';
    copyAddrBtn.addEventListener('click', async ()=>{
      try {
        await navigator.clipboard.writeText(addrInput.value);
        notify('Address copied', 'success');
      } catch(e){
        notify('Could not copy', 'error');
      }
    });
  }
  
  // Copy WIF
  if(!copyWifBtn.dataset.bound){
    copyWifBtn.dataset.bound = '1';
    copyWifBtn.addEventListener('click', async ()=>{
      try {
        await navigator.clipboard.writeText(wifInput.value);
        notify('WIF copied', 'success');
      } catch(e){
        notify('Could not copy', 'error');
      }
    });
  }
  
  // Close button
  if(!closeBtn.dataset.bound){
    closeBtn.dataset.bound = '1';
    closeBtn.addEventListener('click', closeModal);
  }
}

document.addEventListener('click', async (ev)=>{
  // Check if clicked on copy icon
  let btn = ev.target.closest('.copyAddr');
  // Also check if clicked on addr-inline container (main address area)
  if(!btn){
    const addrInline = ev.target.closest('#mainAddress');
    if(addrInline){
      btn = addrInline.querySelector('.copyAddr');
    }
  }
  if(!btn) return;
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
    }catch(err){ notify('Could not copy','error'); }
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
    const fmtUSD = (v)=>{ const n = Number(v||0); return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(6)}`; };
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


/* ===== Qverse — set social links (X & Telegram) ===== */
(function setQverseSocialLinks(){
  try{
    const X_URL = "https://x.com/QverseWallet";
    const TG_URL = "https://t.me/QverseWallet";

    function setHref(selectorList, url){
      for (const sel of selectorList){
        const el = document.querySelector(sel);
        if (el && el.tagName && el.tagName.toLowerCase() === 'a') {
          el.setAttribute('href', url);
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener');
          return true;
        }
      }
      return false;
    }

    const xSelectors = ['#twitterBtn', '#xBtn', '[data-social="x"]', 'a.btn-x', 'a[aria-label="X"]', 'a[title="X"]'];
    const tgSelectors = ['#telegramBtn', '[data-social="telegram"]', 'a.btn-telegram', 'a[aria-label="Telegram"]', 'a[title="Telegram"]'];

    const setX = setHref(xSelectors, X_URL);
    const setTG = setHref(tgSelectors, TG_URL);

    // Fallback: scan all anchors by accessible name
    if (!setX || !setTG){
      document.querySelectorAll('a').forEach(a=>{
        const name = (a.getAttribute('aria-label') || a.title || a.textContent || '').toLowerCase();
        if (!setX && (name.includes('twitter') || name === 'x' || name.includes('x.com'))) {
          a.href = X_URL; a.target = '_blank'; a.rel = 'noopener';
        }
        if (!setTG && (name.includes('telegram') || name.includes('t.me'))) {
          a.href = TG_URL; a.target = '_blank'; a.rel = 'noopener';
        }
      });
    }
  }catch(e){ /* noop */ }
})();

// === MINING TAB ===
async function renderMining() {
  const cont = document.getElementById('miningStats');
  if (!cont) return;
  
  const keys = (window.state && Array.isArray(state.keys)) ? state.keys : [];
  const k = keys[keys.length - 1];
  
  cont.innerHTML = '<div class="muted">Loading mining data...</div>';
  
  try {
    // Fetch pool stats
    const poolRes = await fetch('https://pool.qverse.pro/api/stats');
    const poolStats = poolRes.ok ? await poolRes.json() : null;
    
    // Fetch miner stats if we have an address
    let minerStats = null;
    if (k && k.addr) {
      const minerRes = await fetch(`https://pool.qverse.pro/api/miner/${k.addr}`);
      minerStats = minerRes.ok ? await minerRes.json() : null;
    }
    
    let html = '<div class="mining-grid">';
    
    // Pool Stats
    html += '<div class="mining-section">';
    html += '<h4>Pool Stats</h4>';
    if (poolStats) {
      const hashrate = poolStats.pool?.hashrate || poolStats.hashrate || 0;
      const miners = poolStats.pool?.miners || poolStats.miners || 0;
      const blocks = poolStats.pool?.blocksFound || poolStats.blocksFound || 0;
      html += `<div class="stat-row"><span class="label">Hashrate:</span><span class="value">${formatHashrate(hashrate)}</span></div>`;
      html += `<div class="stat-row"><span class="label">Miners:</span><span class="value">${miners}</span></div>`;
      html += `<div class="stat-row"><span class="label">Blocks Found:</span><span class="value">${blocks}</span></div>`;
    } else {
      html += '<div class="muted">Could not load pool stats</div>';
    }
    html += '</div>';
    
    // Miner Stats (if address is mining)
    html += '<div class="mining-section">';
    html += '<h4>Your Mining</h4>';
    if (minerStats && minerStats.hashrate > 0) {
      html += `<div class="stat-row"><span class="label">Your Hashrate:</span><span class="value">${formatHashrate(minerStats.hashrate)}</span></div>`;
      html += `<div class="stat-row"><span class="label">Pending:</span><span class="value">${(minerStats.pending || 0).toFixed(8)} QTC</span></div>`;
      html += `<div class="stat-row"><span class="label">Total Paid:</span><span class="value">${(minerStats.paid || 0).toFixed(8)} QTC</span></div>`;
    } else if (k && k.addr) {
      html += '<div class="muted">Not mining with this address</div>';
      html += `<div class="muted" style="font-size:11px;margin-top:8px;">Start mining at <a href="https://pool.qverse.pro" target="_blank" style="color:var(--primary-300)">pool.qverse.pro</a></div>`;
    } else {
      html += '<div class="muted">No address loaded</div>';
    }
    html += '</div>';
    
    html += '</div>';
    cont.innerHTML = html;
    
  } catch (e) {
    console.error('Mining stats error:', e);
    cont.innerHTML = '<div class="muted">Could not load mining data</div>';
  }
}

function formatHashrate(h) {
  if (!h || h === 0) return '0 H/s';
  const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  let i = 0;
  while (h >= 1000 && i < units.length - 1) { h /= 1000; i++; }
  return h.toFixed(2) + ' ' + units[i];
}

// Listen for Mining tab click
document.addEventListener('click', (ev) => {
  const tab = ev.target.closest('.tab[data-tab="mining"]');
  if (tab) setTimeout(renderMining, 0);
});
