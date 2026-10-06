// The Screens window (every device screen side by side, with the Screens
// checklist) and the overlay injected into every page (red tap dot, captions,
// and a "this screen loaded" message to the Screens window).
import { DEVICES, GROUPS } from "./lib.mjs";

// The screens page: a device checklist at the top and every ticked device as
// a live screen below, all scaled by the same amount so their proportions stay true.
// It can be served from either site's address (see panes.mjs, viewerOrigin), so it
// never reads a screen's own address directly: each screen reports where it is.
export function screensPage() {
  // The Rudi-Sim logo, drawn into the Screens page header and used as its icon.
  const LOGO = (fill) => `<svg viewBox="-10 0 400 245" aria-hidden="true"><defs><linearGradient id="rsg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#2ee6c5"/><stop offset="1" stop-color="#4493f8"/></linearGradient></defs><g fill="none" stroke="url(#rsg)" stroke-width="14" stroke-linejoin="round" stroke-linecap="round"><rect x="20" y="20" width="250" height="160" rx="14"/><path d="M0 196 H290 l-12 14 H12 Z"/><rect x="210" y="60" width="120" height="160" rx="14" fill="${fill}"/><rect x="300" y="110" width="70" height="125" rx="14" fill="${fill}"/></g><circle cx="335" cy="180" r="16" fill="#ff3b30"/></svg>`;
  const FAVICON = `data:image/svg+xml,${encodeURIComponent(LOGO("#06090c").replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" '))}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Rudi-Sim</title><link rel="icon" href="${FAVICON}">
<style>
:root{color-scheme:light dark;--bg:#e9e9ee;--bar:#fff;--ink:#1c1c1e;--sub:#6e6e73;--line:#d1d1d6;--accent:#0a84ff}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--bar:#2c2c2e;--ink:#f2f2f7;--sub:#98989d;--line:#3a3a3c}}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font:14px/1.3 -apple-system,system-ui,sans-serif;overflow:hidden}
header{height:48px;display:flex;align-items:center;gap:12px;padding:0 16px;background:var(--bar);border-bottom:1px solid var(--line);position:relative;z-index:5}
header b{font-size:15px}header .logo{display:flex;margin-right:-4px}header .logo svg{width:30px;height:20px}#count{color:var(--sub)}
#pick{margin-left:auto;padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bar);color:var(--ink);font:inherit;cursor:pointer}
#menu{position:absolute;right:16px;top:44px;width:min(720px,calc(100vw - 32px));max-height:calc(100vh - 70px);overflow:auto;background:var(--bar);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);padding:14px 16px;display:none;columns:3 200px;column-gap:20px}
#menu.open{display:block}#menu h4{margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--sub);break-after:avoid}
#menu section{break-inside:avoid;margin-bottom:12px}#menu label{display:flex;gap:8px;align-items:center;padding:3px 0;cursor:pointer}
#menu .cust{display:flex;gap:6px;align-items:center}#menu .cust input{width:72px;padding:4px 6px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--ink);font:inherit}
#menu .cust button{padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
#menu small{color:var(--sub);margin-left:auto;padding-left:8px}#menu .quick{column-span:all;display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
#menu .opt{column-span:all;display:flex;gap:8px;align-items:center;margin:-4px 0 12px;font-size:13px}
#menu .quick button{padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--ink);font:inherit;font-size:12px;cursor:pointer}
main{position:absolute;top:48px;left:0;right:0;bottom:0;overflow:auto;display:flex;flex-wrap:wrap;align-content:center;align-content:safe center;justify-content:center;justify-content:safe center;gap:18px;padding:16px}
.dev{display:flex;flex-direction:column;align-items:center;gap:6px}.dev .sides{display:flex;gap:8px}.side{display:flex;flex-direction:column;align-items:center;gap:4px}
.tag{height:16px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--sub);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}.tag.after{color:var(--accent)}.tag small{font-weight:400;text-transform:none;letter-spacing:0}.dev .cap{display:flex;justify-content:center;align-items:center;gap:4px;height:16px;width:0;min-width:100%}
.dev .cap span{font-size:12px;color:var(--sub);white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis}
.dev .rot,.dev .one{flex:none;width:16px;height:16px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--sub);font:13px/16px -apple-system,system-ui,sans-serif;cursor:pointer}.dev .rot:hover,.dev .one:hover{background:var(--line);color:var(--ink)}.dev .one.on{background:var(--accent);color:#fff}
.cut{position:absolute;z-index:2;background:#000;pointer-events:none;display:none}
.frame{position:relative;overflow:hidden;border-radius:10px;background:Canvas;box-shadow:0 0 0 1px var(--line),0 6px 20px rgba(0,0,0,.18)}
.frame iframe{position:absolute;left:0;top:0;border:0;transform-origin:0 0;color-scheme:normal}
#empty{color:var(--sub)}
.st{position:absolute;inset:0;z-index:3;display:none;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:10px;text-align:center;background:color-mix(in srgb,var(--bg) 88%,transparent);font-size:12px;color:var(--ink)}
.frame[data-state=loading] .st{display:flex}.frame[data-state=error] .st{display:flex;background:var(--bar)}
.st b{font-size:13px}.st code{font-size:11px;word-break:break-all;color:var(--sub)}.st button{padding:4px 12px;border:1px solid var(--line);border-radius:6px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
#hint{color:var(--sub);font-size:12px;margin-left:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
</style></head><body>
<header><span class="logo">${LOGO("var(--bar)")}</span><b>Rudi-Sim</b><span id="count"></span><span id="hint" title="Steps Claude or ChatGPT sends run on every screen. A click, scroll or typing you do yourself stays in the screen you use, so put the screens back in step with a goto step.">Steps sync on every screen · your own clicks stay in one</span><button id="pick" aria-expanded="false">Screens ▾</button><div id="menu"></div></header>
<main id="grid"></main>
<script>
const DEVICES=${JSON.stringify(DEVICES)};
const GROUPS=${JSON.stringify(GROUPS)};
const TYPES={iphone:"iPhones",ipad:"iPads",mac:"Macs"};
const init=JSON.parse(decodeURIComponent(location.hash.slice(1)||"{}"));
let keys=init.keys||GROUPS.default, landscape=!!init.landscape, startUrl=init.url||"/";
// Compare mode: every screen twice, Before (this site) and After (the same path on the other site).
let cmp=init.compare?new URL(init.compare).origin:null;
// The Before site. The page itself may be served from the After site (an https Before with an
// http After would otherwise be blocked as mixed content), so never assume location is Before.
let before=init.before?new URL(init.before).origin:location.origin;
// Where each screen last said it was (screens report in with a message, which works across sites).
const seen={};
function afterUrl(u){try{const x=new URL(u,location.href);return cmp+x.pathname+x.search+x.hash}catch{return cmp+"/"}}
const host=u=>{try{return new URL(u).host}catch{return u}};
function sideHtml(k,d,after){return '<div class="side">'+(cmp?'<div class="tag'+(after?' after':'')+'">'+(after?'After':'Before')+' <small>'+(after?host(cmp):host(before))+'</small></div>':'')+
  '<div class="frame" data-state="loading"><iframe name="'+k+(after?'|after':'')+'" title="'+d.name+(after?' (After)':' (Before)')+'"></iframe><i class="cut"></i><div class="st"></div></div></div>'}
const known=Object.fromEntries(DEVICES.map(d=>[d.key,d]));
function custom(w,h){w=+w;h=+h;if(!(w>=200&&h>=200&&w<=7680&&h<=4320))return null;
  return {key:"custom-"+w+"x"+h,name:"Custom "+w+"×"+h,type:w<600?"iphone":w<1100?"ipad":"mac",width:w,height:h}}
const byKey=new Proxy({}, {get:(_,k)=>known[k]||(String(k).startsWith("custom-")?custom(...String(k).slice(7).split("x")):undefined)});
const grid=document.getElementById("grid"), menu=document.getElementById("menu"), pickBtn=document.getElementById("pick");
const rot=new Set(init.rot||[]);
// One screen shown at its actual size (1 CSS pixel per pixel), the rest hidden; null shows them all.
let actual=null;
// A screen turned with its rotate button is the other way round from the rest.
const turned=d=>d.type!=="mac"&&(landscape!==rot.has(d.key));
function size(d){return turned(d)?[d.height,d.width]:[d.width,d.height];}
// Notch or Dynamic Island in the screen's own points (approximate): width, height, gap
// from the edge, and the space Safari keeps clear of it (status bar upright, each side turned).
const CUTS={notch:[209,30,0,47,44],"notch-small":[162,33,0,47,44],island:[125,37,11,59,59]};
function currentUrl(){const f=grid.querySelector('iframe:not([name$="|after"])');return (f&&seen[f.name])||startUrl}
// Each screen's frame carries what it was asked to load and whether it has: loading, ready or error.
function load(f,u){f.dataset.requested=u;f.dataset.loaded="0";setState(f,"loading");f.src=u}
function setState(f,state,error){const fr=f.parentElement;if(!fr)return;fr.dataset.state=state;f.dataset.state=state;
  const st=fr.querySelector(".st");if(!st)return;
  st.innerHTML=state==="error"?'<b>This screen didn\u2019t load</b><span></span><code></code><button type="button">Retry</button>':state==="loading"?'<span>Loading\u2026</span><code></code>':"";
  if(state!=="ready")st.querySelector("code").textContent=f.dataset.requested||"";
  if(state==="error"){st.querySelector("span").textContent=error||"";st.querySelector("button").onclick=()=>load(f,f.dataset.requested)}}
function render(){
  const url=currentUrl(), have=new Map([...grid.querySelectorAll(".dev")].map(el=>[el.dataset.key,el]));
  for(const [k,el] of have) if(!keys.includes(k)) el.remove();
  keys.forEach((k,i)=>{let el=have.get(k);const d=byKey[k];if(!d)return;
    if(el&&el.dataset.cmp!==String(cmp)){el.remove();el=null}
    if(!el){el=document.createElement("div");el.className="dev";el.dataset.key=k;el.dataset.cmp=String(cmp);
      el.innerHTML='<div class="sides">'+sideHtml(k,d,false)+(cmp?sideHtml(k,d,true):'')+'</div><div class="cap"><span></span>'+(d.type!=="mac"?'<button class="rot" title="Rotate this screen" aria-label="Rotate '+d.name+'">⟳</button>':'')+'<button class="one" title="Actual size (click again for all screens)" aria-label="Actual size '+d.name+'">⤢</button></div>';
      el.querySelectorAll("iframe").forEach(f=>load(f,f.name.endsWith("|after")?afterUrl(url):url));}
    el.querySelector(".cap span").textContent=d.name;el.querySelector(".cap span").title=d.name; grid.appendChild(el);});
  if(actual&&!keys.includes(actual))actual=null;
  count();
  if(!keys.length){grid.innerHTML='<p id="empty">Tick some screens in “Screens”.</p>'}
  else document.getElementById("empty")?.remove();
  fit(); drawMenu();
}
function count(){document.getElementById("count").textContent=(actual?byKey[actual].name+" at actual size · ⤢ again for all "+keys.length+" screens":keys.length+" screen"+(keys.length===1?"":"s"))+(cmp?" · Before "+host(before)+" / After "+host(cmp):"");}
// Largest single scale at which every screen fits the window, wrapping into rows.
function fit(){
  grid.querySelectorAll(".dev").forEach(el=>{el.style.display=actual&&el.dataset.key!==actual?"none":"";el.querySelector(".one")?.classList.toggle("on",el.dataset.key===actual)});
  const W=grid.clientWidth-34,H=grid.clientHeight-34,G=18,L=22+(cmp?20:0),n=cmp?2:1,PG=8;
  const sizes=keys.filter(k=>byKey[k]&&(!actual||k===actual)).map(k=>size(byKey[k]));
  if(!sizes.length)return;
  const fits=s=>{let rowW=0,rowH=0,total=0,rows=0;
    for(const [w,h] of sizes){const sw=w*s*n+PG*(n-1),sh=h*s+L;
      if(rowW&&rowW+G+sw>W){total+=rowH;rows++;rowW=0;rowH=0}
      rowW+=(rowW?G:0)+sw;rowH=Math.max(rowH,sh);if(sw>W)return false;}
    total+=rowH;rows++;return total+G*(rows-1)<=H;};
  let lo=0.02,hi=1;for(let i=0;i<30;i++){const m=(lo+hi)/2;fits(m)?lo=m:hi=m}
  const s=actual?1:lo;
  grid.querySelectorAll(".dev").forEach(el=>{const [w,h]=size(byKey[el.dataset.key]);
    el.querySelectorAll(".side").forEach(sd=>{const fr=sd.querySelector(".frame"),f=sd.querySelector("iframe");sd.querySelector(".tag")?.style.setProperty("max-width",w*s+"px");
    fr.style.width=w*s+"px";fr.style.height=h*s+"px";
    const d=byKey[el.dataset.key],c=!document.body.classList.contains("nocut")&&CUTS[d.cutout],cut=sd.querySelector(".cut");
    // Safari keeps the page out from under the cutout: below the status bar when upright,
    // clear of both sides when turned. The page frame shrinks by that much.
    const side=turned(d),top=c&&!side?c[3]:0,edge=c&&side?c[4]:0;
    f.style.left=edge*s+"px";f.style.top=top*s+"px";f.style.width=(w-2*edge)+"px";f.style.height=(h-top)+"px";f.style.transform="scale("+s+")";
    if(!c){cut.style.display="none";return}
    const [cw,ch,gap]=c.map(v=>v*s),r=ch*0.45;
    Object.assign(cut.style,{display:"block",width:(side?ch:cw)+"px",height:(side?cw:ch)+"px",
      left:(side?gap:(w*s-cw)/2)+"px",top:(side?(h*s-cw)/2:gap)+"px",
      borderRadius:gap?Math.min(cw,ch)/2+"px":side?"0 "+r+"px "+r+"px 0":"0 0 "+r+"px "+r+"px"});});});
}
function drawMenu(){
  let h='<div class="quick">'+Object.keys(GROUPS).map(g=>'<button data-g="'+g+'">'+g+'</button>').join("")+'<button data-g="none">none</button></div>'+
    '<label class="opt"><input type="checkbox" id="showcut"'+(document.body.classList.contains("nocut")?"":" checked")+'>Show the notch or Dynamic Island, and the space Safari leaves around it</label>';
  for(const t of Object.keys(TYPES)){h+='<section><h4>'+TYPES[t]+'</h4>'+DEVICES.filter(d=>d.type===t).map(d=>
    '<label><input type="checkbox" value="'+d.key+'"'+(keys.includes(d.key)?" checked":"")+'>'+d.name+'<small>'+d.width+'×'+d.height+'</small></label>').join("")+'</section>'}
  const customs=keys.filter(k=>k.startsWith("custom-"));
  h+='<section><h4>Custom size</h4>'+customs.map(k=>'<label><input type="checkbox" value="'+k+'" checked>'+byKey[k].name+'</label>').join("")+
    '<form class="cust"><input name="w" type="number" min="200" max="7680" placeholder="width" required> × <input name="h" type="number" min="200" max="4320" placeholder="height" required> <button>Add</button></form></section>';
  menu.innerHTML=h;
}
menu.addEventListener("change",e=>{if(e.target.type!=="checkbox")return; // leaving a custom-size box also fires change; it must not redraw the menu
  if(e.target.id==="showcut"){document.body.classList.toggle("nocut",!e.target.checked);fit();return}
  const k=e.target.value;keys=e.target.checked?[...keys,k]:keys.filter(x=>x!==k);
  keys=[...DEVICES.map(d=>d.key).filter(x=>keys.includes(x)),...keys.filter(x=>x.startsWith("custom-"))];render();});
menu.addEventListener("submit",e=>{e.preventDefault();const f=e.target,d=custom(f.w.value,f.h.value);
  if(!d){f.w.setCustomValidity("200 to 7680 by 200 to 4320");f.reportValidity();return}
  if(!keys.includes(d.key))keys=[...keys,d.key];render();menu.classList.add("open");});
menu.addEventListener("click",e=>{const g=e.target.dataset?.g;if(!g)return;keys=g==="none"?[]:[...GROUPS[g]];render();});
function rotate(k){rot.has(k)?rot.delete(k):rot.add(k);fit();}
function showActual(k){actual=k&&k!==actual?k:null;count();fit();return actual;}
grid.addEventListener("click",e=>{const b=e.target.closest(".rot,.one");if(!b)return;const k=b.closest(".dev").dataset.key;
  b.classList.contains("rot")?rotate(k):showActual(k)});
pickBtn.onclick=()=>{const o=menu.classList.toggle("open");pickBtn.setAttribute("aria-expanded",o)};
document.addEventListener("click",e=>{if(!menu.contains(e.target)&&e.target!==pickBtn)menu.classList.remove("open")});
addEventListener("resize",fit);
window.__screens={keys:()=>keys.slice(),setDevices(k){keys=k.slice();render()},rotate(ks){ks.forEach(rotate);return [...rot]},
  actual(k){actual=k||null;count();fit();return actual},
  goAll(u){startUrl=u;try{before=new URL(u).origin}catch{}count();grid.querySelectorAll("iframe").forEach(f=>load(f,f.name.endsWith("|after")?afterUrl(u):u))},
  // Reload only the named screens (frame names); the healthy ones keep their page and state.
  reload(names){const done=[];grid.querySelectorAll("iframe").forEach(f=>{if(names.includes(f.name)){load(f,f.dataset.requested||afterUrl(currentUrl()));done.push(f.name)}});return done},
  setPane(name,state,error){const f=[...grid.querySelectorAll("iframe")].find(x=>x.name===name);if(f)setState(f,state,error);return !!f},
  panes:()=>[...grid.querySelectorAll("iframe")].map(f=>({name:f.name,requested:f.dataset.requested||null,reported:seen[f.name]||null,state:f.dataset.state||"loading"})),
  setCompare(c){startUrl=currentUrl();cmp=c?new URL(c).origin:null;render();return cmp}};
grid.addEventListener("load",e=>{if(e.target.tagName==="IFRAME")e.target.dataset.loaded="1"},true);
// A screen whose page loaded says so (see OVERLAY). Blocked or failed screens never do.
addEventListener("message",e=>{const m=e.data;if(!m||m.rudiSim!=="ready")return;
  const f=[...grid.querySelectorAll("iframe")].find(x=>x.contentWindow===e.source);if(!f)return;
  seen[f.name]=String(m.href);if(f.dataset.state!=="error"||m.error!==true)setState(f,m.error?"error":"ready",m.error?m.message:"")});
render();
</script></body></html>`;
}

// Injected into every page: the red tap dot and the caption bar.
export const OVERLAY = `(() => {
  if (window.__sim) return;
  // Lives in a closed shadow root so the page (and Claude's text search) never sees it.
  let dot, cap, host;
  const mk = () => {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    const root = host.attachShadow({ mode: "closed" });
    dot = document.createElement("div");
    dot.style.cssText = "position:fixed;left:-50px;top:-50px;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:rgba(255,59,48,.35);border:2px solid #ff3b30;box-shadow:0 0 0 2px rgba(255,255,255,.8);transition:left .45s ease,top .45s ease,transform .15s";
    cap = document.createElement("div");
    cap.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:88vw;padding:8px 14px;border-radius:14px;background:rgba(0,0,0,.78);color:#fff;font:600 14px/1.35 -apple-system,system-ui,sans-serif;opacity:0;transition:opacity .25s;text-align:center";
    root.append(dot, cap);
    document.documentElement.append(host);
  };
  let t;
  window.__sim = {
    move(x, y) { mk(); dot.style.left = x + "px"; dot.style.top = y + "px"; },
    pulse() { if (!dot) return; dot.style.transform = "scale(.6)"; setTimeout(() => (dot.style.transform = "scale(1)"), 160); },
    say(text) { mk(); cap.textContent = text; cap.style.opacity = 1; clearTimeout(t); t = setTimeout(() => (cap.style.opacity = 0), 3500); },
    hide(h) { if (host) host.style.visibility = h ? "hidden" : "visible"; },
  };
  if (window.top !== window) {
    // Inside a side-by-side screen, links that would open a new tab stay in this screen.
    document.addEventListener("click", (e) => { const a = e.target.closest && e.target.closest("a[target]"); if (a && a.target !== "_self") a.target = "_self"; }, true);
    window.open = (u) => { if (u) location.href = u; return window; };
    // A screen in the Screens window tells it where it is once loaded, so the
    // Screens window can show which screens are ready (it can't look across sites).
    if (window.parent === window.top && /^[a-z0-9x-]+(\\|after)?$/.test(window.name)) {
      const err = () => document.querySelector('meta[name="rudi-sim-error"]');
      const post = () => { const e = err(); try { window.parent.postMessage({ rudiSim: "ready", href: location.href, error: !!e, message: e ? e.content : "" }, "*"); } catch {} };
      addEventListener("load", post); addEventListener("hashchange", post); addEventListener("popstate", post);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mk); else mk();
})();`;
