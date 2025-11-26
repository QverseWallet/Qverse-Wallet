(() =>{
  "use strict";
  function bindDelegation(){
    const cont = document.getElementById("activityList");
    if(!cont || cont.dataset.toggleBound==="1") return;
    cont.dataset.toggleBound = "1";
    cont.addEventListener("click", (ev)=>{
      const link = ev.target.closest("a"); if(link) return;
      const row = ev.target.closest(".tx-row"); if(!row || !cont.contains(row)) return;
      const open = !row.classList.contains("open");
      row.classList.toggle("open", open);
      row.setAttribute("aria-expanded", String(open));
    });
    cont.addEventListener("keydown", (ev)=>{
      if(ev.key!=="Enter" && ev.key!==" ") return;
      const row = ev.target.closest(".tx-row"); if(!row || !cont.contains(row)) return;
      ev.preventDefault();
      const open = !row.classList.contains("open");
      row.classList.toggle("open", open);
      row.setAttribute("aria-expanded", String(open));
    });
  }
  if (document.readyState==="loading") document.addEventListener("DOMContentLoaded", bindDelegation, {once:true}); else bindDelegation();
})();