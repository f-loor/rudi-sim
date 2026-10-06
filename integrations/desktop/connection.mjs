// The ChatGPT connection: OpenAI's tunnel-client, run by Rudi-Sim with the
// tunnel key from the system's secret store. Used by the desktop app and by the
// command-line companion. It has no Electron code, so it is tested with Node.
//
// States (state.state):
//   needs-setup   no tunnel id, key or tunnel-client yet
//   disconnected  the person chose Disconnect (kept across restarts)
//   starting      tunnel-client launched, not reporting yet
//   connecting    tunnel-client reporting, not yet ready / linked to OpenAI
//   connected     tunnel-client says ready and its link to OpenAI is ok
//   reconnecting  was connected (or should be) and isn't right now; retrying
//   auth-failed   OpenAI didn't accept the key; needs a new one, no retries
//   failed        gave up after repeated failures; Restart tries again
//   stopping      on the way down
//
// Rules this keeps:
//   - Only one tunnel-client per tunnel at a time (OpenAI doesn't support
//     overlap): one manager holds a lock file, and a restart stops the old
//     process (and confirms it has gone) before starting the new one.
//   - It only ever stops processes it started: each is remembered with its
//     start time and a unique part of its command line (see proc.mjs).
//   - A process that is running is not "connected": tunnel-client's own
//     health report decides (see tunnel-health.mjs).
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, alive, isSame, remember, stopOwned } from "../../skills/rudi-sim/scripts/proc.mjs";
import { classify, probe } from "./tunnel-health.mjs";

export const KEY_NAME = (tunnelId) => `tunnel:${tunnelId}`;
const TUNNEL_ID = /^tunnel_[A-Za-z0-9]{8,64}$/;
export const validTunnelId = (id) => TUNNEL_ID.test(String(id || ""));

const DEFAULTS = { pollMs: 2000, startGraceMs: 60000, degradedRestartMs: 120000, resumeGraceMs: 30000, stableMs: 60000, maxAttempts: 5, backoffMs: (n) => Math.min(30000, 1000 * 2 ** (n - 1)) };

export class Connection extends EventEmitter {
  // settings: { get(): {tunnelClient, tunnelId, intent}, set(patch) }
  // credentials: store() from credentials.mjs, or null when the computer has none
  // mcpCommand: the command tunnel-client starts to reach Rudi-Sim (a string)
  // hub: optional { setRemote(bool), drainRemote(ms), stopRemoteSession() }
  constructor({ home, settings, credentials, mcpCommand, hub = null, env = process.env, prefix = [], timings = {} }) {
    super();
    Object.assign(this, { home, settings, credentials, mcpCommand, hub, env, prefix, t: { ...DEFAULTS, ...timings } });
    mkdirSync(home, { recursive: true });
    this.state = { state: "disconnected", detail: null, since: new Date().toISOString(), attempts: 0, evidence: null, pid: null, lastConnectedAt: null, lastError: null };
    this.child = null; this.rec = null; this.key = null; this.timer = null; this.poller = null; this.halted = true; this.releaseLock = null; this.op = Promise.resolve();
    this.lastTick = Date.now();
  }

  // ---- logs and state, never with the key in them ----
  redact(t) { return this.key ? String(t).split(this.key).join("[hidden]") : String(t); }
  log(line) { try { appendFileSync(join(this.home, "connection.log"), `${new Date().toISOString()} ${this.redact(line)}\n`); } catch {} }
  set(state, detail = null, extra = {}) {
    const changed = state !== this.state.state;
    Object.assign(this.state, { state, detail, ...extra });
    if (changed) { this.state.since = new Date().toISOString(); this.log(`${state}${detail ? `: ${detail}` : ""}`); }
    // ChatGPT's calls are allowed again only once the tunnel is verified ready,
    // and never while the person's choice is "disconnected" (Disconnect turns them off).
    if (state === "connected" && this.hub && !this.hub.remote && this.settings.get().intent !== "disconnected") this.hub.setRemote(true);
    try { writeFileSync(join(this.home, "connection.json"), JSON.stringify({ ...this.state, pid: this.rec?.pid ?? null, owner: process.pid }, null, 2)); } catch {}
    this.emit("change", this.status());
  }
  status() { return { ...this.state, intent: this.settings.get().intent || "connected" }; }

  // Serialises connect/disconnect/restart so a double click can't start two tunnels.
  serial(fn) { const p = this.op.then(fn, fn); this.op = p.catch(() => {}); return p; }

  // ---- processes we started, kept on disk so a later run can clean up ----
  ownedFile() { return join(this.home, "owned-tunnels.json"); }
  readOwned() { try { return JSON.parse(readFileSync(this.ownedFile(), "utf8")); } catch { return []; } }
  writeOwned(list) { const f = this.ownedFile(), tmp = `${f}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(list, null, 2)); renameSync(tmp, f); }

  // A tunnel left running by an earlier run that was force-closed or crashed.
  // Stopped only if it is provably the one that run started.
  async recoverOrphans() {
    const out = [];
    for (const rec of this.readOwned()) {
      if (rec.owner && rec.owner !== process.pid && alive(rec.owner) && isSame({ pid: rec.owner, started: rec.ownerStarted })) { out.push({ pid: rec.pid, result: "kept (its Rudi-Sim is still running)" }); continue; }
      const r = await stopOwned(rec);
      out.push({ pid: rec.pid, result: r });
      this.log(`earlier tunnel ${rec.pid}: ${r}`);
    }
    this.writeOwned(this.readOwned().filter((rec) => out.find((o) => o.pid === rec.pid)?.result.startsWith("kept")));
    return out;
  }

  // On app start: clean up, then follow the person's last choice.
  init() {
    return this.serial(async () => {
      const recovered = await this.recoverOrphans();
      const s = this.settings.get();
      if (!this.ready().ok) this.set("needs-setup", this.ready().why);
      else if (s.intent === "disconnected") this.set("disconnected", "You disconnected Rudi-Sim from ChatGPT. Choose Connect to reconnect.");
      else await this.launch();
      return recovered;
    });
  }

  ready() {
    const s = this.settings.get();
    if (!this.credentials) return { ok: false, why: "This computer has no secure password store, so the tunnel key can't be kept safely." };
    if (!s.tunnelClient) return { ok: false, why: "tunnel-client hasn't been chosen yet." };
    if (!validTunnelId(s.tunnelId)) return { ok: false, why: "No tunnel ID yet." };
    return { ok: true };
  }

  connect() {
    return this.serial(async () => {
      this.settings.set({ intent: "connected" });
      if (this.child && this.state.state !== "failed" && this.state.state !== "auth-failed") return this.status();
      this.state.attempts = 0;
      await this.launch();
      return this.status();
    });
  }

  restart() {
    return this.serial(async () => {
      this.settings.set({ intent: "connected" });
      await this.stopTunnel("restart");
      this.state.attempts = 0;
      await this.launch();
      return this.status();
    });
  }

  // Disconnect: stop taking remote commands, let one already running finish,
  // finish the recording of a session ChatGPT started, then stop the tunnel and
  // confirm it has gone. Settings, the key, recordings and local Claude use stay.
  disconnect({ remember = true } = {}) {
    return this.serial(async () => {
      if (remember) this.settings.set({ intent: "disconnected" });
      this.halted = true; this.stopTimers();
      this.set("stopping", "Disconnecting…");
      const report = { stopped: true, recording: null, recordingError: null, inFlight: null };
      if (this.hub) {
        this.hub.setRemote(false);
        report.inFlight = await this.hub.drainRemote(20000);
        try { report.recording = await this.hub.stopRemoteSession(); }
        catch (e) { report.recordingError = e.message; }
      }
      const r = await this.stopTunnel("disconnect");
      report.stopped = r !== "still-running";
      this.set("disconnected", report.stopped ? "Disconnected. Rudi-Sim isn't reachable from ChatGPT until you choose Connect." : "The tunnel didn't stop. Try Disconnect again or restart your computer.", { lastDisconnect: report });
      return report;
    });
  }

  // Quit: like Disconnect, but the person's choice is kept for next time.
  shutdown() { return this.disconnect({ remember: false }); }

  stopTimers() { clearTimeout(this.timer); this.timer = null; clearInterval(this.poller); this.poller = null; }

  async stopTunnel(why) {
    this.stopTimers();
    const rec = this.rec, child = this.child;
    this.child = null; this.rec = null;
    let r = "gone";
    if (rec) r = await stopOwned(rec);
    else if (child && alive(child.pid)) { child.kill(); r = "stopped"; }
    if (rec) this.writeOwned(this.readOwned().filter((x) => x.pid !== rec.pid || alive(rec.pid)));
    this.releaseLock?.(); this.releaseLock = null;
    if (rec) this.log(`tunnel ${rec.pid} ${why}: ${r}`);
    return r;
  }

  async launch() {
    this.stopTimers();
    const s = this.settings.get(), ok = this.ready();
    if (!ok.ok) return this.set("needs-setup", ok.why);
    if (!this.releaseLock) {
      this.releaseLock = acquireLock(join(this.home, "connection.lock"), { role: "connection" });
      if (!this.releaseLock) {
        let who = null; try { who = JSON.parse(readFileSync(join(this.home, "connection.lock"), "utf8")).pid; } catch {}
        return this.set("failed", `Another copy of Rudi-Sim${who ? ` (process ${who})` : ""} is already managing the ChatGPT connection. Quit it first.`);
      }
    }
    try { this.key = await this.credentials.get(KEY_NAME(s.tunnelId)); }
    catch (e) { return this.set("needs-setup", `Couldn't read the saved key: ${e.message}`); }
    if (!this.key) return this.set("needs-setup", "No tunnel key is saved yet.");
    this.halted = false;
    this.state.attempts++;
    const urlFile = join(this.home, `health-${randomBytes(6).toString("hex")}.url`);
    rmSync(urlFile, { force: true });
    const args = [...this.prefix.slice(1), "run", "--health.listen-addr", "127.0.0.1:0", "--health.url-file", urlFile, "--health.show-details=true"];
    const cmd = this.prefix[0] || s.tunnelClient;
    let child;
    try {
      child = spawn(cmd, args, {
        env: { ...this.env, CONTROL_PLANE_API_KEY: this.key, CONTROL_PLANE_TUNNEL_ID: s.tunnelId, MCP_COMMAND: this.mcpCommand, RUDI_SIM_CLIENT: "chatgpt", HEALTH_SHOW_DETAILS: "true" },
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
      });
    } catch (e) { return this.failed(null, e.message); }
    this.child = child; this.urlFile = urlFile; this.launchedAt = Date.now(); this.lastTick = Date.now();
    // Remembered by its start time and its own health file name, which no other process has.
    this.rec = { ...remember(child.pid, urlFile), owner: process.pid, ownerStarted: remember(process.pid).started, tunnelId: s.tunnelId, at: new Date().toISOString() };
    this.writeOwned([...this.readOwned().filter((x) => x.pid !== child.pid), this.rec]);
    let tail = "";
    const write = (d) => { const t = this.redact(d.toString()); tail = (tail + t).slice(-2000); try { appendFileSync(join(this.home, "tunnel.log"), t); } catch {} };
    child.stdout.on("data", write); child.stderr.on("data", write);
    child.once("error", (e) => this.failed(child, e.code === "ENOENT" ? `Couldn't find tunnel-client at ${cmd}. Choose it again in Settings.` : e.message));
    child.once("exit", (code, sig) => this.failed(child, `tunnel-client stopped (${sig || `exit ${code}`})${tail.trim() ? `: ${tail.trim().split(/\r?\n/).slice(-2).join(" | ")}` : ""}`));
    this.set("starting", "Starting tunnel-client…", { pid: child.pid, evidence: null });
    this.poller = setInterval(() => this.tick(), this.t.pollMs);
    this.tick();
  }

  // A tunnel-client that ended or never connected: try again later, a few times.
  failed(child, why) {
    if (child && child !== this.child) return;
    const ranMs = this.launchedAt ? Date.now() - this.launchedAt : 0;
    if (child) { this.writeOwned(this.readOwned().filter((x) => x.pid !== child.pid)); this.child = null; this.rec = null; }
    this.stopTimers();
    if (this.halted) return;
    if (ranMs >= this.t.stableMs && this.state.lastConnectedAt) this.state.attempts = 0;
    if (this.state.attempts >= this.t.maxAttempts) {
      this.releaseLock?.(); this.releaseLock = null;
      return this.set("failed", `${why}. Stopped retrying after ${this.state.attempts} tries; choose Restart connection once the problem is fixed.`, { lastError: why });
    }
    const wait = this.t.backoffMs(this.state.attempts);
    this.set("reconnecting", `${why}. Trying again in ${Math.max(1, Math.round(wait / 1000))}s (try ${this.state.attempts + 1} of ${this.t.maxAttempts}).`, { lastError: why });
    this.timer = setTimeout(() => this.serial(() => (this.halted || this.child ? null : this.launch())), wait);
  }

  // Restart a tunnel-client that is running but not connected, after waiting.
  async replace(why) {
    return this.serial(async () => {
      if (this.halted) return;
      // One that had been connected for a while gets a fresh set of tries.
      if (this.launchedAt && Date.now() - this.launchedAt >= this.t.stableMs && this.state.lastConnectedAt) this.state.attempts = 0;
      await this.stopTunnel(why);
      if (this.state.attempts >= this.t.maxAttempts) return this.set("failed", `${why}. Stopped retrying after ${this.state.attempts} tries; choose Restart connection once the problem is fixed.`, { lastError: why });
      await this.launch();
    });
  }

  async tick() {
    if (!this.child || this.ticking) return;
    this.ticking = true;
    try {
      // A long gap between ticks means the computer was asleep.
      const now = Date.now(), gap = now - this.lastTick; this.lastTick = now;
      if (gap > Math.max(30000, this.t.pollMs * 10)) this.resumed();
      let base = null; try { base = readFileSync(this.urlFile, "utf8").trim(); } catch {}
      const c = classify(await probe(base));
      if (!this.child) return;
      if (c.state === "auth-failed") {
        this.halted = true;
        await this.serial(() => this.stopTunnel("auth"));
        return this.set("auth-failed", `${c.detail} Replace the key in Settings; it may have expired or been revoked.`, { evidence: c.evidence, auth: true });
      }
      if (c.state === "connected") {
        // (Tries aren't reset here: a tunnel that connects for a moment and then
        // crashes would otherwise retry forever. They reset once it has stayed up for a while; see failed() and replace().)
        this.state.lastConnectedAt = new Date().toISOString();
        return this.set("connected", c.detail, { evidence: c.evidence, lastError: null, auth: false });
      }
      const since = Date.parse(this.state.since);
      const wasConnected = this.state.state === "connected" || this.state.state === "reconnecting";
      if (wasConnected) {
        this.set("reconnecting", c.detail, { evidence: c.evidence });
        if (now - Date.parse(this.state.since) > (this.resumeAt ? this.t.resumeGraceMs : this.t.degradedRestartMs)) { this.resumeAt = null; await this.replace("Still not reconnected"); }
      } else {
        this.set(c.evidence === "no-health-answer" ? "starting" : "connecting", c.detail, { evidence: c.evidence });
        if (now - this.launchedAt > this.t.startGraceMs) await this.replace(`Didn't connect within ${Math.round(this.t.startGraceMs / 1000)}s`);
      }
      void since;
    } finally { this.ticking = false; }
  }

  // After sleep: check straight away, and replace the tunnel if it doesn't recover soon.
  resumed() {
    this.resumeAt = Date.now();
    this.log("computer woke up; checking the connection");
    if (this.state.state === "connected") this.set("reconnecting", "Checking the connection after sleep…");
    if (!this.child && !this.halted && this.settings.get().intent !== "disconnected") this.serial(() => (this.child ? null : this.launch()));
  }

  // For the app: the operating system says the computer just woke up.
  onResume() { this.resumed(); this.tick(); }

  // Asks tunnel-client to check the settings and key (its `doctor` command).
  // tunnel-client's own output, with the key removed.
  async check() {
    const s = this.settings.get();
    const key = await this.credentials?.get(KEY_NAME(s.tunnelId)).catch(() => null);
    if (!key) return { ok: false, output: "No tunnel key is saved yet." };
    const cmd = this.prefix[0] || s.tunnelClient;
    const r = spawnSync(cmd, [...this.prefix.slice(1), "doctor", "--explain"], { env: { ...this.env, CONTROL_PLANE_API_KEY: key, CONTROL_PLANE_TUNNEL_ID: s.tunnelId, MCP_COMMAND: this.mcpCommand }, encoding: "utf8", timeout: 60000, windowsHide: true });
    const out = `${r.stdout || ""}${r.stderr || ""}${r.error ? r.error.message : ""}`.split(key).join("[hidden]");
    return { ok: r.status === 0, output: out.trim().slice(-4000) };
  }
}

// The command tunnel-client runs to reach Rudi-Sim: the program and its script
// (if any), quoted. On Windows a short (8.3) path is used when the real one has
// spaces or non-ASCII letters, in case tunnel-client splits the command at spaces.
export function mcpCommandFor(parts, extra = ["--client", "chatgpt", "--hub-only"]) {
  return [...[].concat(parts).map((p) => `"${shortPath(p)}"`), ...extra].join(" ");
}
export function shortPath(p) {
  if (process.platform !== "win32" || !/[\s^&()!%]|[^\x20-\x7e]/.test(p) || !existsSync(p)) return p;
  const r = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${p}") do @echo %~sI`], { encoding: "utf8", windowsHide: true });
  const short = r.stdout?.trim().split(/\r?\n/).pop();
  return r.status === 0 && short && existsSync(short) ? short : p;
}
