"use strict";
var runEl=document.getElementById("runOptimal"), scrambleEl=document.getElementById("scramble"),
    clearEl=document.getElementById("clear"), out=document.getElementById("out"),
    statusEl=document.getElementById("status"), streamed=document.getElementById("streamed");
var worker=new Worker("nissy-worker.js"), id=1, bytes=0, ready=false;
function line(t,cls){ var s=document.createElement("span"); if(cls)s.className=cls; s.textContent=t+"\n"; out.appendChild(s); out.scrollTop=out.scrollHeight; }
worker.onerror=function(e){ statusEl.textContent="Worker error: "+(e.message||e); };
worker.onmessage=function(ev){ var m=ev.data||{};
  if(m.type==="ready"){ ready=true; runEl.disabled=false; statusEl.textContent="Engine ready."; return; }
  if(m.type==="fatal"){ statusEl.textContent="Error: "+m.message; return; }
  if(m.type==="stream"){ bytes+=m.len; streamed.textContent="streamed: "+(bytes/1048576).toFixed(1)+" MB ("+m.name+" off="+m.off+")"; line("[stream] "+m.name+" off="+m.off+" len="+m.len,"s"); return; }
  if(m.type==="out"){ line(m.line,""); return; }
  if(m.type==="err"){ line(m.line,"e"); return; }
  if(m.type==="done"){ statusEl.textContent="Done. Streamed "+(bytes/1048576).toFixed(1)+" MB."; }
};
runEl.addEventListener("click",function(){
  out.textContent=""; bytes=0; streamed.textContent="";
  statusEl.textContent="Running solve optimal\u2026";
  worker.postMessage({type:"run",id:id++,args:["solve","optimal",scrambleEl.value]});
});
clearEl.addEventListener("click",function(){ out.textContent=""; });
