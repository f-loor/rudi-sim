// One simulator for every assistant on this computer. The desktop app runs the
// hub; Claude Code (locally) and ChatGPT (through the tunnel) reach it through
// the same MCP bridge program, which forwards their tool calls here.
//
// - Calls run one at a time.
// - The client that opened the simulator owns it. Another client gets a clear
//   "in use by …" answer instead of taking it over. If the owner has gone away
//   (its process ended), the next client may continue, and is told so.
// - ChatGPT's calls can be switched off (Disconnect); a call already running is
//   allowed to finish.
// - The hub listens on 127.0.0.1 only, on a random port, and every request needs
//   the random token in hub.json (readable by this user only).
import { EventEmitter } from "node:events";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive } from "../../skills/rudi-sim/scripts/proc.mjs";

export const KINDS = ["claude", "chatgpt", "app", "local"];
export const hubFile = (home) => join(home, "hub.json");
const LABEL = { claude: "Claude Code", chatgpt: "ChatGPT", app: "the Rudi-Sim app", local: "a local assistant" };

export class Hub extends EventEmitter {
  constructor({ bridge, home, version = "dev" }) {
    super();
    Object.assign(this, { bridge, home, version });
    this.clients = new Map();
    this.owner = null;
    this.remote = true;
    this.queue = Promise.resolve();
    this.inflight = new Set();
    this.token = randomBytes(24).toString("hex");
  }

  label(c) { return c ? `${LABEL[c.kind] || c.kind}${c.name && c.kind !== "app" ? ` (${c.name})` : ""}` : "nobody"; }
  // The same client: ChatGPT counts as one (its connection may be restarted);
  // local clients are told apart by their process.
  same(a, b) { return !!a && !!b && a.kind === b.kind && (a.kind === "chatgpt" || a.kind === "app" || a.id === b.id); }
  ownerGone() { return !!this.owner && this.owner.pid && !alive(this.owner.pid); }

  hello(client) {
    const c = normClient(client);
    this.clients.set(c.id, { ...c, since: new Date().toISOString() });
    this.emit("change", this.status());
    return { ok: true, version: this.version, remote: this.remote };
  }
  bye(client) { this.clients.delete(normClient(client).id); this.emit("change", this.status()); }

  setRemote(on) { this.remote = !!on; this.emit("change", this.status()); }
  async drainRemote(ms = 20000) {
    const end = Date.now() + ms;
    while ([...this.inflight].some((x) => x.kind === "chatgpt") && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    return [...this.inflight].filter((x) => x.kind === "chatgpt").length;
  }
  // Ends a session ChatGPT opened, finishing its recording. Returns the recording or null.
  async stopRemoteSession() {
    if (!this.bridge.running() || this.owner?.kind !== "chatgpt") return null;
    const r = await this.run({ id: "app", kind: "app" }, "rudi_stop", {}, { force: true });
    const parsed = resultJson(r);
    if (r.isError) throw new Error(parsed?.error || "The recording couldn't be finished.");
    return parsed?.recording || null;
  }
  // Ends any session (quitting the app).
  async stopAny() {
    if (!this.bridge.running()) return null;
    const r = await this.run({ id: "app", kind: "app" }, "rudi_stop", {}, { force: true });
    return resultJson(r)?.recording || null;
  }

  status() {
    for (const [id, c] of this.clients) if (c.pid && !alive(c.pid)) this.clients.delete(id);
    return {
      version: this.version, remote: this.remote,
      clients: [...this.clients.values()].map((c) => ({ kind: c.kind, name: c.name, label: this.label(c), since: c.since })),
      simulator: { ...this.bridge.info?.simulator, running: this.bridge.running(), owner: this.owner ? this.label(this.owner) : null, ownerKind: this.owner?.kind || null, ownerConnected: this.owner ? !this.ownerGone() : null },
      lastRecording: this.bridge.info?.lastRecording || null,
      busy: this.inflight.size > 0,
    };
  }

  // A tool call from a client. `force` is only for the app's own buttons, which
  // the person presses on purpose (for example "Stop their session").
  async call(client, name, args = {}, { force = false } = {}) {
    const c = normClient(client);
    if (c.kind === "chatgpt" && !this.remote) return err("Rudi-Sim is disconnected from ChatGPT on this computer. Open the Rudi-Sim app and choose Connect.");
    if (name === "rudi_status") {
      const r = await this.bridge.call("rudi_status", {});
      return withNote(r, this.ownerNote(c));
    }
    const job = { kind: c.kind, name };
    this.inflight.add(job);
    try { return await this.run(c, name, args, { force }); }
    finally { this.inflight.delete(job); this.emit("change", this.status()); }
  }

  run(c, name, args, { force }) {
    const p = this.queue.then(async () => {
      let note = null;
      const running = this.bridge.running();
      if (!running) this.owner = null;
      if (running && this.owner && !this.same(this.owner, c)) {
        if (force) note = `Stopped ${this.label(this.owner)}'s session at your request.`;
        else if (this.ownerGone()) note = `Continuing the simulator ${this.label(this.owner)} opened; it is no longer connected.`;
        else return err(`The simulator is in use by ${this.label(this.owner)}. Finish there (or stop it from the Rudi-Sim app), then try again.`, { conflict: true, owner: this.label(this.owner) });
        if (name !== "rudi_stop" && !force) this.owner = { ...c };
      }
      let r;
      try { r = await this.bridge.call(name, args); }
      catch (e) { r = err(e.message); }
      if (name === "rudi_start" && !r.isError) this.owner = { ...c };
      if (name === "rudi_stop" || !this.bridge.running()) this.owner = null;
      return withNote(r, note);
    });
    this.queue = p.catch(() => {});
    return p;
  }

  ownerNote(c) {
    if (!this.owner || !this.bridge.running()) return null;
    return this.same(this.owner, c) ? null : `The simulator is in use by ${this.label(this.owner)}.`;
  }

  // ---- the local endpoint the bridge program forwards to ----
  listen() {
    this.server = http.createServer((req, res) => {
      const send = (code, body) => res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
      if (req.headers.host !== `127.0.0.1:${this.port}`) return send(403, { error: "forbidden" });
      if (req.headers["x-rudi-token"] !== this.token) return send(403, { error: "forbidden" });
      if (req.method === "GET" && req.url === "/status") return send(200, this.status());
      if (req.method !== "POST") return send(404, { error: "not found" });
      let body = "";
      req.on("data", (d) => { body += d; if (body.length > 1 << 20) req.destroy(); });
      req.on("end", async () => {
        let m; try { m = JSON.parse(body || "{}"); } catch { return send(400, { error: "bad json" }); }
        try {
          if (req.url === "/hello") return send(200, this.hello(m.client));
          if (req.url === "/bye") { this.bye(m.client); return send(200, { ok: true }); }
          // Only the app itself may use force, and it doesn't go through HTTP.
          if (req.url === "/call") return send(200, await this.call(m.client, m.name, m.arguments || {}));
        } catch (e) { return send(200, err(e.message)); }
        send(404, { error: "not found" });
      });
    });
    return new Promise((ok, fail) => {
      this.server.once("error", fail);
      this.server.listen(0, "127.0.0.1", () => {
        this.port = this.server.address().port;
        mkdirSync(this.home, { recursive: true });
        const f = hubFile(this.home), tmp = `${f}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ port: this.port, token: this.token, pid: process.pid, version: this.version }), { mode: 0o600 });
        try { chmodSync(tmp, 0o600); } catch {}
        renameSync(tmp, f);
        ok(this.port);
      });
    });
  }
  close() {
    this.server?.close();
    try { if (JSON.parse(readFileSync(hubFile(this.home), "utf8")).pid === process.pid) rmSync(hubFile(this.home), { force: true }); } catch {}
  }
}

// The JSON answer inside a tool result (a note may come before it).
export function resultJson(r) {
  for (const c of r?.content || []) if (c.type === "text") { try { const v = JSON.parse(c.text); if (v && typeof v === "object") return v; } catch {} }
  return null;
}
function normClient(c = {}) {
  const kind = KINDS.includes(c.kind) ? c.kind : "local";
  const pid = Number.isInteger(c.pid) && c.pid > 0 ? c.pid : null;
  return { id: String(c.id || `${kind}:${pid || "?"}`).slice(0, 80), kind, pid, name: c.name ? String(c.name).slice(0, 60) : null };
}
function err(message, extra = {}) { return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, ...extra }) }] }; }
function withNote(r, note) { return note ? { ...r, content: [{ type: "text", text: note }, ...(r.content || [])] } : r; }

// Used by the bridge program: is the app's hub running, and how to reach it.
export function readHub(home) {
  try {
    const h = JSON.parse(readFileSync(hubFile(home), "utf8"));
    return h.port && h.token && alive(h.pid) ? h : null;
  } catch { return null; }
}
