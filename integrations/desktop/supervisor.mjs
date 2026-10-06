#!/usr/bin/env node
// The command-line companion's background process, for computers without the
// desktop app (Linux, or people who prefer a terminal). It runs the same
// service as the app: the shared simulator, the ChatGPT connection and the
// recordings library, plus a small status page on this computer only.
// Started and stopped by rudi-sim-desktop.mjs; it survives closing the terminal.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { store, systemProvider } from "./credentials.mjs";
import { Service } from "./service.mjs";
import { Settings, desktopHome } from "./settings.mjs";
import { acquireLock } from "../../skills/rudi-sim/scripts/proc.mjs";

export { desktopHome };
export const bridgeScript = fileURLToPath(new URL("../local-bridge/server.mjs", import.meta.url));
export const readState = (home = desktopHome()) => { try { return JSON.parse(readFileSync(join(home, "companion.json"), "utf8")); } catch { return null; } };

// The credential store to use. Tests may ask for a key from the environment
// instead (RUDI_SIM_CREDENTIAL_PROVIDER=env-for-tests); nothing else does.
export function credentialStore(env = process.env) {
  if (env.RUDI_SIM_CREDENTIAL_PROVIDER === "env-for-tests") {
    return store({ label: "test key from the environment", available: () => true, get: async () => env.RUDI_SIM_TEST_KEY || null, set: async () => {}, delete: async () => true });
  }
  const p = systemProvider();
  return p ? store(p) : null;
}

// Opens a file, folder or page with this computer's default app. Local only.
export function openLocal(target) {
  const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [target]] : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
  const c = spawn(cmd, args, { detached: true, stdio: "ignore" });
  c.on("error", () => {}); c.unref();
}

export class Supervisor {
  constructor({ home = desktopHome(), env = process.env, connectionOptions = {} } = {}) {
    this.home = home; this.env = env;
    this.settings = new Settings(home, env);
    // The command-line companion is for ChatGPT; turn that on once set up.
    if (!this.settings.get().use.chatgpt && this.settings.get().tunnelId) this.settings.set({ use: { ...this.settings.get().use, chatgpt: true } });
    this.token = randomBytes(24).toString("hex");
    // Tests stand in for tunnel-client with a script (only alongside the test key source).
    const testTunnel = env.RUDI_SIM_CREDENTIAL_PROVIDER === "env-for-tests" && env.RUDI_SIM_TEST_TUNNEL ? { prefix: JSON.parse(env.RUDI_SIM_TEST_TUNNEL), timings: { pollMs: 200, backoffMs: () => 200 } } : {};
    this.service = new Service({ home, settings: this.settings, credentials: credentialStore(env), launcher: [process.execPath, bridgeScript], headless: env.RUDI_BRIDGE_HEADLESS === "1", connectionOptions: { env, ...testTunnel, ...connectionOptions } });
  }
  log(line) { try { appendFileSync(join(this.home, "companion.log"), `${new Date().toISOString()} ${line}\n`); } catch {} }
  save() { writeFileSync(join(this.home, "companion.json"), JSON.stringify({ pid: process.pid, page: this.page, token: this.token, startedAt: this.startedAt }, null, 2), { mode: 0o600 }); }

  async start() {
    mkdirSync(this.home, { recursive: true });
    // One Rudi-Sim service per user: the app and this companion share the lock.
    this.release = acquireLock(join(this.home, "service.lock"), { role: "companion" });
    if (!this.release) throw new Error("Rudi-Sim is already running on this computer (the app or the companion).");
    this.startedAt = new Date().toISOString();
    await this.listen();
    this.save();
    await this.service.start();
    this.log(`started (status page ${this.page})`);
  }

  async quit() {
    if (this.quitting) return this.quitting;
    this.quitting = (async () => {
      const report = await this.service.quit();
      this.server?.close();
      this.release?.();
      this.log(`stopped ${JSON.stringify({ recording: report.recording?.video || null, connection: report.connection?.stopped })}`);
      return report;
    })();
    return this.quitting;
  }

  listen() {
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const json = (code, body) => res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
      // Refuse requests addressed to any other host name (DNS rebinding), and any without the token.
      if (req.headers.host !== `127.0.0.1:${this.port}`) return json(403, { error: "forbidden" });
      const token = url.searchParams.get("token") || req.headers["x-rudi-token"];
      if (token !== this.token) return json(403, { error: "forbidden" });
      if (req.method === "GET" && url.pathname === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" }).end(statusPage());
      if (req.method === "GET" && url.pathname === "/api/status") return json(200, { ...this.service.status(), recordings: this.service.library.list().slice(0, 5) });
      // Actions need the token in a header, which a page on another site can't add.
      if (req.method !== "POST" || req.headers["x-rudi-token"] !== this.token) return json(404, { error: "not found" });
      try {
        const c = this.service.connection;
        if (url.pathname === "/api/connect") return json(200, { ok: true, status: await c.connect() });
        if (url.pathname === "/api/disconnect") return json(200, { ok: true, report: await c.disconnect() });
        if (url.pathname === "/api/restart") return json(200, { ok: true, status: await c.restart() });
        if (url.pathname === "/api/quit") { const report = await this.quit(); json(200, { ok: true, report }); setTimeout(() => process.exit(0), 100); return; }
        if (url.pathname === "/api/open-recording" || url.pathname === "/api/open-folder") {
          const latest = this.service.library.list().find((s) => s.state === "ready");
          const target = url.pathname === "/api/open-folder" ? (latest?.folder || this.service.library.root) : latest?.video;
          if (!target || !existsSync(target)) return json(404, { ok: false, error: "No finished recording yet." });
          openLocal(target); return json(200, { ok: true, opened: target });
        }
      } catch (e) { return json(200, { ok: false, error: e.message }); }
      json(404, { error: "not found" });
    });
    return new Promise((ok) => this.server.listen(0, "127.0.0.1", () => { this.port = this.server.address().port; this.page = `http://127.0.0.1:${this.port}`; ok(); }));
  }
}

const LABELS = { "needs-setup": "Needs setup", disconnected: "Disconnected", starting: "Starting", connecting: "Connecting", connected: "Connected", reconnecting: "Reconnecting", "auth-failed": "Key not accepted", failed: "Stopped retrying", stopping: "Disconnecting" };
function statusPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Rudi-Sim</title>
<style>:root{color-scheme:light dark;--line:#8884;--ok:#1f9d55;--bad:#d64545;--wait:#b7791f}body{font:15px/1.45 -apple-system,system-ui,sans-serif;max-width:640px;margin:32px auto;padding:0 16px}
h1{font-size:20px}.row{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--line)}.dot{width:12px;height:12px;border-radius:50%;margin-top:5px;flex:none;background:var(--wait)}
.ok .dot{background:var(--ok)}.bad .dot{background:var(--bad)}.row b{display:block}.row small{opacity:.75;word-break:break-word}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:Canvas;color:CanvasText;cursor:pointer}#msg{margin-top:12px;opacity:.8}</style></head>
<body><h1>Rudi-Sim</h1><div id="rows">Loading…</div>
<div class="actions"><button data-a="connect">Connect</button><button data-a="disconnect">Disconnect</button><button data-a="restart">Restart connection</button><button data-a="open-recording">Open latest recording</button><button data-a="open-folder">Open recordings folder</button><button data-a="quit">Quit</button></div><div id="msg"></div>
<script>
const LABELS=${JSON.stringify(LABELS)};
const token=new URLSearchParams(location.search).get("token");
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
const row=(ok,title,detail)=>'<div class="row '+(ok===true?"ok":ok===false?"bad":"")+'"><i class="dot"></i><div><b>'+esc(title)+'</b><small>'+esc(detail)+'</small></div></div>';
async function load(){try{const s=await (await fetch("/api/status",{headers:{"x-rudi-token":token}})).json();
 const c=s.connection,h=s.hub,sim=h.simulator;
 document.getElementById("rows").innerHTML=
  row(c.state==="connected"?true:["auth-failed","failed"].includes(c.state)?false:null,"ChatGPT connection: "+(LABELS[c.state]||c.state),c.detail||"")+
  row(h.clients.length?true:null,h.clients.length?"Assistants connected":"No assistant connected",h.clients.map(x=>x.label).join(", ")||"Claude Code or ChatGPT connect when you use Rudi-Sim.")+
  row(sim.running?(sim.ready===false?false:true):null,sim.running?"Simulator open":"Simulator not open",sim.running?((sim.screens||"")+(sim.owner?" · used by "+sim.owner:"")+(sim.error?" · "+sim.error:"")):"Opens when an assistant starts a walkthrough.")+
  row(s.recordings.length?true:null,"Recordings",s.recordings.length?("Latest: "+s.recordings[0].title+" ("+s.recordings[0].state+")"):("Saved in "+s.settings.recordingsDir));
}catch(e){document.getElementById("rows").textContent="Rudi-Sim isn't answering. Start it again with rudi-sim-desktop start."}}
document.querySelector(".actions").onclick=async e=>{const a=e.target.dataset?.a;if(!a)return;document.getElementById("msg").textContent="Working…";const r=await fetch("/api/"+a,{method:"POST",headers:{"x-rudi-token":token}}).then(r=>r.json()).catch(()=>({}));
 document.getElementById("msg").textContent=r.ok?(r.opened?"Opened "+r.opened:"Done."):(r.error||"That didn't work.");load()};
load();setInterval(load,2000);
</script></body></html>`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = new Supervisor();
  try { await s.start(); }
  catch (e) { console.error(e.message); process.exit(4); }
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, () => s.quit().finally(() => process.exit(0)));
}
