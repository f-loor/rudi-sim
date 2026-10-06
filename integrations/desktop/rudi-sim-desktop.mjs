#!/usr/bin/env node
// Rudi-Sim from a terminal, for computers without the desktop app (Linux) or
// people who prefer it. Same service as the app: one simulator shared by
// Claude Code and ChatGPT, the ChatGPT connection, and the recordings folder.
//
//   rudi-sim-desktop setup --tunnel-client <path> --tunnel-id <id> [--replace-key] [--key-stdin]
//   rudi-sim-desktop start            start in the background (does nothing if already running)
//   rudi-sim-desktop quit             stop everything (also: stop)
//   rudi-sim-desktop connect          connect to ChatGPT with the saved key
//   rudi-sim-desktop disconnect       stop the ChatGPT connection until you connect again
//   rudi-sim-desktop restart          restart a faulty connection
//   rudi-sim-desktop status [--json]
//   rudi-sim-desktop open             open the status page
//   rudi-sim-desktop open-recording | open-folder
//   rudi-sim-desktop claude-command   the command that connects Claude Code to Rudi-Sim
//   rudi-sim-desktop forget           delete the saved key and tunnel ID (asks first)
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeScript, credentialStore, desktopHome, openLocal, readState } from "./supervisor.mjs";
import { KEY_NAME, mcpCommandFor, validTunnelId } from "./connection.mjs";
import { Settings } from "./settings.mjs";
import { Library } from "./library.mjs";
import { alive } from "../../skills/rudi-sim/scripts/proc.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [cmd = "status", ...rest] = process.argv.slice(2);
const opt = (n) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
const home = desktopHome();
const settings = new Settings(home);

async function ping(state) {
  if (!state?.page || !alive(state.pid)) return false;
  try { return (await fetch(`${state.page}/api/status`, { headers: { "x-rudi-token": state.token }, signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
}
async function post(action, timeout = 60000) {
  const st = readState(home);
  if (!(await ping(st))) throw new Error("Rudi-Sim isn't running. Start it with: rudi-sim-desktop start");
  return (await fetch(`${st.page}/api/${action}`, { method: "POST", headers: { "x-rudi-token": st.token }, signal: AbortSignal.timeout(timeout) })).json();
}

// Reads the key without showing it: only from a person at a terminal, or from
// stdin when they explicitly pass --key-stdin.
async function askKey() {
  if (rest.includes("--key-stdin")) { let s = ""; for await (const c of process.stdin) s += c; return s.trim(); }
  if (!process.stdin.isTTY) throw new Error("Run setup in a terminal so you can type the key (or pipe it in with --key-stdin).");
  process.stdout.write("Paste your tunnel runtime API key (it won't be shown), then press Enter: ");
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
  return new Promise((ok, fail) => {
    let key = "";
    const on = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") { done(); return ok(key.trim()); }
        if (c === "\u0003") { done(); return fail(new Error("Cancelled.")); }
        if (c === "\u007f" || c === "\b") key = key.slice(0, -1); else key += c;
      }
    };
    const done = () => { process.stdin.off("data", on); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n"); };
    process.stdin.on("data", on);
  });
}

function which(bin) {
  if (bin && existsSync(bin)) return resolve(bin);
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin || "tunnel-client"], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

async function setup() {
  const checks = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push([major >= 18, `Node.js ${process.versions.node}${major >= 18 ? "" : " (needs 18 or newer)"}`]);
  const bridgeHome = resolve(process.env.RUDI_BRIDGE_HOME || join(home, "bridge"));
  if (!existsSync(join(bridgeHome, "node_modules", "playwright"))) {
    console.log("Installing Playwright and WebKit (one time, about 300 MB)…");
    const r = spawnSync(process.execPath, [join(here, "..", "..", "skills", "rudi-sim", "scripts", "setup.mjs")], { stdio: "inherit", env: { ...process.env, RUDI_SIM_HOME: bridgeHome } });
    checks.push([r.status === 0, "Playwright and WebKit"]);
  } else checks.push([true, `Playwright and WebKit in ${bridgeHome}`]);
  const tc = which(opt("--tunnel-client") || settings.get().tunnelClient);
  checks.push([!!tc, tc ? `tunnel-client at ${tc}` : "tunnel-client not found. Download it from https://platform.openai.com/settings/organization/tunnels, then run: setup --tunnel-client <full path>"]);
  const id = opt("--tunnel-id") || settings.get().tunnelId;
  checks.push([validTunnelId(id), validTunnelId(id) ? `Tunnel ID ${id}` : "No tunnel ID. Copy it from https://platform.openai.com/settings/organization/tunnels and run: setup --tunnel-id tunnel_…"]);
  const creds = credentialStore();
  checks.push([!!creds, creds ? `Key storage: ${creds.label}` : "No secret store found. On Linux install libsecret-tools (secret-tool). The key is never saved to a plain file."]);
  settings.set({ ...(tc ? { tunnelClient: tc } : {}), ...(validTunnelId(id) ? { tunnelId: id } : {}), use: { ...settings.get().use, chatgpt: true } });
  if (creds && validTunnelId(id)) {
    const have = await creds.get(KEY_NAME(id)).catch(() => null);
    if (!have || rest.includes("--replace-key")) {
      const key = await askKey();
      if (!key) throw new Error("No key entered; nothing saved.");
      await creds.set(KEY_NAME(id), key);
      checks.push([true, `Key saved in ${creds.label}`]);
    } else checks.push([true, `Key already saved in ${creds.label} (use --replace-key to change it)`]);
  }
  for (const [ok, text] of checks) console.log(`${ok ? "✓" : "✗"} ${text}`);
  if (checks.every(([ok]) => ok)) console.log("\nReady. Start it with: rudi-sim-desktop start");
  else process.exitCode = 1;
}

async function start() {
  const st = readState(home);
  if (await ping(st)) { console.log("Already running."); return status(); }
  const c = spawn(process.execPath, [join(here, "supervisor.mjs")], { detached: true, stdio: "ignore", windowsHide: true });
  c.unref();
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    const s = readState(home);
    if (s?.pid === c.pid && await ping(s)) { console.log("Started in the background. You can close this window."); return status(); }
    if (c.exitCode !== null) break;
  }
  throw new Error(`Rudi-Sim didn't start. See ${join(home, "companion.log")}`);
}

async function quit() {
  const st = readState(home);
  if (!st || !(await ping(st))) { console.log("Not running."); return; }
  const r = await post("quit", 90000).catch((e) => ({ ok: false, error: e.message }));
  for (let i = 0; i < 80 && alive(st.pid); i++) await sleep(250);
  if (r.report?.recording?.video) console.log(`Recording saved: ${r.report.recording.video}`);
  if (r.report?.recordingError) console.log(`The recording couldn't be finished: ${r.report.recordingError}`);
  console.log(alive(st.pid) ? "Rudi-Sim didn't stop in time." : "Stopped.");
}

const LABELS = { "needs-setup": "needs setup", disconnected: "disconnected", starting: "starting", connecting: "connecting", connected: "connected", reconnecting: "reconnecting", "auth-failed": "key not accepted", failed: "stopped retrying", stopping: "disconnecting" };
async function status() {
  const st = readState(home);
  if (!(await ping(st))) {
    if (rest.includes("--json")) { console.log(JSON.stringify({ running: false })); return; }
    console.log("Rudi-Sim isn't running. Start it with: rudi-sim-desktop start"); return;
  }
  const s = await (await fetch(`${st.page}/api/status`, { headers: { "x-rudi-token": st.token } })).json();
  if (rest.includes("--json")) { console.log(JSON.stringify({ running: true, ...s }, null, 2)); return; }
  const c = s.connection, h = s.hub;
  console.log(`${c.state === "connected" ? "✓" : "·"} ChatGPT: ${LABELS[c.state] || c.state}${c.detail ? ` (${c.detail})` : ""}`);
  console.log(`${h.clients.length ? "✓" : "·"} Assistants connected: ${h.clients.map((x) => x.label).join(", ") || "none"}`);
  console.log(`${h.simulator.running ? "✓" : "·"} Simulator ${h.simulator.running ? `open${h.simulator.owner ? `, used by ${h.simulator.owner}` : ""}` : "not open"}`);
  console.log(`  Recordings: ${s.settings.recordingsDir}`);
}

async function main() {
  if (cmd === "setup") return setup();
  if (cmd === "start") return start();
  if (cmd === "quit" || cmd === "stop") return quit();
  if (cmd === "connect" || cmd === "restart") { const r = await post(cmd); if (!r.ok) throw new Error(r.error); await sleep(1500); return status(); }
  if (cmd === "disconnect") {
    const r = await post("disconnect", 90000);
    if (!r.ok) throw new Error(r.error);
    if (r.report.recording?.video) console.log(`ChatGPT's recording was saved: ${r.report.recording.video}`);
    if (r.report.recordingError) console.log(`The recording couldn't be finished: ${r.report.recordingError}`);
    console.log(r.report.stopped ? "Disconnected. ChatGPT can't reach Rudi-Sim until you run: rudi-sim-desktop connect" : "The tunnel didn't stop; try again.");
    return;
  }
  if (cmd === "status") return status();
  if (cmd === "open") { const st = readState(home); if (!(await ping(st))) throw new Error("Not running. Start it first: rudi-sim-desktop start"); openLocal(`${st.page}/?token=${st.token}`); return; }
  if (cmd === "open-recording" || cmd === "open-folder") {
    const lib = new Library({ root: settings.get().recordingsDir });
    const latest = lib.list().find((s) => s.state === "ready");
    const target = cmd === "open-folder" ? (latest?.folder || lib.root) : latest?.video;
    if (!target || !existsSync(target)) throw new Error(`No finished recording yet in ${lib.root}.`);
    openLocal(target); console.log(`Opened ${target}`); return;
  }
  if (cmd === "claude-command") { console.log(`claude mcp add --scope user rudi-sim -- ${mcpCommandFor([process.execPath, bridgeScript], ["--client", "claude"])}`); return; }
  if (cmd === "forget") {
    const s = settings.get();
    if (!rest.includes("--yes")) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const a = await rl.question("Delete the saved tunnel key and tunnel ID from this computer? Recordings and other settings stay. Type yes: "); rl.close();
      if (a.trim().toLowerCase() !== "yes") { console.log("Nothing deleted."); return; }
    }
    const creds = credentialStore();
    if (s.tunnelId && creds) await creds.delete(KEY_NAME(s.tunnelId)).catch(() => {});
    settings.set({ tunnelId: null, use: { ...s.use, chatgpt: false } });
    console.log("Forgot the ChatGPT connection. Set it up again any time with: rudi-sim-desktop setup");
    return;
  }
  console.log(`Usage: rudi-sim-desktop setup | start | quit | connect | disconnect | restart | status | open | open-recording | open-folder | claude-command | forget`);
  process.exitCode = 2;
}

main().catch((e) => { console.error(e.message); process.exit(1); });
