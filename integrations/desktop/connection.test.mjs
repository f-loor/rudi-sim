#!/usr/bin/env node
// The ChatGPT connection and the shared hub, with a stand-in for OpenAI's
// tunnel-client (fake-tunnel.mjs). These prove the logic; they can't prove a
// real tunnel to OpenAI, which needs a real tunnel ID and key.
// Usage: node --test integrations/desktop/connection.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Connection, KEY_NAME } from "./connection.mjs";
import { memoryProvider, store } from "./credentials.mjs";
import { Hub } from "./hub.mjs";
import { classify } from "./tunnel-health.mjs";
import { alive, isSame, remember } from "../../skills/rudi-sim/scripts/proc.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const fake = join(here, "fake-tunnel.mjs");
const KEY = "sk-test-not-a-real-key-456";
const TUNNEL = "tunnel_0123456789abcdef";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return false; };
const FAST = { pollMs: 100, startGraceMs: 4000, degradedRestartMs: 1500, resumeGraceMs: 800, stableMs: 60000, maxAttempts: 3, backoffMs: () => 100 };

function setup({ connected = true, control = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), "rudi-conn-"));
  const controlFile = join(home, "control.json");
  writeFileSync(controlFile, JSON.stringify(control));
  let saved = { tunnelClient: process.execPath, tunnelId: TUNNEL, intent: connected ? "connected" : "disconnected" };
  const settingsFile = join(home, "settings.json");
  const settings = { get: () => { try { return JSON.parse(readFileSync(settingsFile, "utf8")); } catch { return saved; } }, set: (p) => { saved = { ...settings.get(), ...p }; writeFileSync(settingsFile, JSON.stringify(saved)); } };
  settings.set({});
  const creds = store(memoryProvider());
  const make = (extra = {}) => new Connection({ home, settings, credentials: creds, mcpCommand: "", prefix: [process.execPath, fake], env: { ...process.env, FAKE_TUNNEL_CONTROL: controlFile }, timings: FAST, ...extra });
  const ctl = (c) => writeFileSync(controlFile, JSON.stringify(c));
  return { home, settings, creds, make, ctl, clean: () => rmSync(home, { recursive: true, force: true }) };
}
const owned = (home) => { try { return JSON.parse(readFileSync(join(home, "owned-tunnels.json"), "utf8")); } catch { return []; } };
const liveTunnels = (home) => owned(home).filter((r) => isSame(r));

test("health report: a running process isn't a connection", () => {
  assert.equal(classify({ reachable: false }).state, "connecting");
  assert.equal(classify({ reachable: true, readyz: 503, health: { ready: false, components: { "control-plane": { status: "unknown" } } } }).state, "connecting");
  assert.equal(classify({ reachable: true, readyz: 200, health: { ready: true, components: { "control-plane": { status: "ok" } } } }).state, "connected");
  assert.equal(classify({ reachable: true, readyz: 200, health: { ready: true, components: { "control-plane": { status: "degraded", reason_code: "network_unreachable" } } } }).state, "reconnecting");
  assert.equal(classify({ reachable: true, readyz: 200, health: { components: { "control-plane": { status: "degraded", reason_code: "unauthorized" } } } }).state, "auth-failed");
  const older = classify({ reachable: true, readyz: 200, health: null });
  assert.equal(older.state, "connected"); assert.equal(older.evidence, "readyz-only");
});

test("needs setup without a tunnel ID or key; connects only once tunnel-client reports ready", async () => {
  const s = setup({ control: { readyz: 503, controlPlane: { status: "unknown" } } });
  const c = s.make();
  try {
    await c.init();
    assert.equal(c.state.state, "needs-setup");
    await s.creds.set(KEY_NAME(TUNNEL), KEY);
    await c.connect();
    assert.ok(await until(() => c.state.state === "connecting"), c.state.state);
    await sleep(500);
    assert.equal(c.state.state, "connecting", "process running but not ready is not connected");
    s.ctl({ readyz: 200, controlPlane: { status: "ok" } });
    assert.ok(await until(() => c.state.state === "connected"), c.state.state);
    assert.equal(c.state.evidence, "control-plane");
    for (const f of ["tunnel.log", "connection.log", "connection.json"]) assert.ok(!readFileSync(join(s.home, f), "utf8").includes(KEY), `${f} hides the key`);
    assert.match(readFileSync(join(s.home, "tunnel.log"), "utf8"), /\[hidden\]/);
  } finally { await c.shutdown(); s.clean(); }
});

test("network loss while tunnel-client stays alive: reconnecting, recovery, then a replacement (never two at once)", async () => {
  const s = setup({ control: { readyz: 200, controlPlane: { status: "ok" } } });
  await s.creds.set(KEY_NAME(TUNNEL), KEY);
  const c = s.make();
  let maxAlive = 0;
  const watch = setInterval(() => { maxAlive = Math.max(maxAlive, liveTunnels(s.home).length); }, 20);
  try {
    await c.init();
    assert.ok(await until(() => c.state.state === "connected"));
    const first = c.state.pid;
    s.ctl({ readyz: 200, controlPlane: { status: "degraded", reason_code: "network_unreachable" } });
    assert.ok(await until(() => c.state.state === "reconnecting"), c.state.state);
    assert.equal(c.state.pid, first, "tunnel-client is still running");
    s.ctl({ readyz: 200, controlPlane: { status: "ok" } });
    assert.ok(await until(() => c.state.state === "connected"), "recovers on its own");
    assert.equal(c.state.pid, first);
    // A link that stays down is replaced: the old process is stopped first.
    s.ctl({ readyz: 200, controlPlane: { status: "degraded", reason_code: "network_unreachable" } });
    assert.ok(await until(() => c.state.pid && c.state.pid !== first, 10000), "replaced after waiting");
    assert.ok(!alive(first), "the old tunnel-client is gone");
    s.ctl({ readyz: 200, controlPlane: { status: "ok" } });
    assert.ok(await until(() => c.state.state === "connected"));
    assert.equal(maxAlive, 1, "never two tunnel-clients at the same time");
  } finally { clearInterval(watch); await c.shutdown(); s.clean(); }
});

test("a rejected key stops retrying and asks for a new one", async () => {
  const s = setup({ control: { readyz: 503, controlPlane: { status: "degraded", reason_code: "unauthorized" } } });
  await s.creds.set(KEY_NAME(TUNNEL), KEY);
  const c = s.make();
  try {
    await c.init();
    assert.ok(await until(() => c.state.state === "auth-failed"), c.state.state);
    assert.match(c.state.detail, /Replace the key/);
    await sleep(500);
    assert.equal(liveTunnels(s.home).length, 0, "no tunnel left running");
  } finally { await c.shutdown(); s.clean(); }
});

test("a crashing tunnel-client is retried a bounded number of times", async () => {
  const s = setup({ control: { exit: 3 } });
  await s.creds.set(KEY_NAME(TUNNEL), KEY);
  const c = s.make();
  try {
    await c.init();
    assert.ok(await until(() => c.state.state === "failed"), c.state.state);
    assert.equal(c.state.attempts, FAST.maxAttempts);
    assert.match(c.state.detail, /Stopped retrying/);
    s.ctl({ readyz: 200, controlPlane: { status: "ok" } });
    await c.restart();
    assert.ok(await until(() => c.state.state === "connected"), "Restart tries again");
  } finally { await c.shutdown(); s.clean(); }
});

test("disconnect is remembered across restarts; connect needs no key entry; repeated cycles leave nothing running", async () => {
  const s = setup({ control: { readyz: 200, controlPlane: { status: "ok" } } });
  await s.creds.set(KEY_NAME(TUNNEL), KEY);
  try {
    for (let i = 0; i < 5; i++) {
      const c = s.make();
      await c.init();
      await c.connect();
      assert.ok(await until(() => c.state.state === "connected"), `cycle ${i}: ${c.state.state}`);
      const pid = c.state.pid;
      const report = await c.disconnect();
      assert.equal(report.stopped, true);
      assert.ok(!alive(pid), `cycle ${i}: the tunnel has stopped`);
      assert.equal(c.state.state, "disconnected");
      // The app restarts: it stays disconnected.
      const again = s.make();
      await again.init();
      assert.equal(again.state.state, "disconnected");
      assert.equal(liveTunnels(s.home).length, 0);
      await again.connect();
      assert.ok(await until(() => again.state.state === "connected"), "connect uses the saved key");
      await again.disconnect();
    }
    assert.equal(liveTunnels(s.home).length, 0);
  } finally { s.clean(); }
});

// Runs a Connection in its own process, so the test can kill that process outright.
function connectionProcess(s, extra = "") {
  const code = `
    import { Connection } from ${JSON.stringify(pathToFileURL(join(here, "connection.mjs")).href)};
    import { store, memoryProvider } from ${JSON.stringify(pathToFileURL(join(here, "credentials.mjs")).href)};
    const creds = store(memoryProvider()); await creds.set(${JSON.stringify(KEY_NAME(TUNNEL))}, ${JSON.stringify(KEY)});
    const settings = { get: () => ({ tunnelClient: process.execPath, tunnelId: ${JSON.stringify(TUNNEL)}, intent: "connected" }), set: () => {} };
    const c = new Connection({ home: ${JSON.stringify(s.home)}, settings, credentials: creds, mcpCommand: "", prefix: [process.execPath, ${JSON.stringify(fake)}], env: { ...process.env, FAKE_TUNNEL_CONTROL: ${JSON.stringify(join(s.home, "control.json"))} }, timings: ${JSON.stringify({ ...FAST, backoffMs: undefined })} });
    await c.init();
    ${extra}
    setInterval(() => console.log(JSON.stringify(c.state)), 100);`;
  const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  let last = null;
  p.stdout.on("data", (d) => { for (const l of String(d).trim().split("\n")) { try { last = JSON.parse(l); } catch {} } });
  return { p, state: () => last };
}

test("force-closed app: the next start stops the tunnel it left behind, and nothing else", async () => {
  const s = setup({ control: { readyz: 200, controlPlane: { status: "ok" } } });
  await s.creds.set(KEY_NAME(TUNNEL), KEY);
  const stranger = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  try {
    const a = connectionProcess(s);
    assert.ok(await until(() => a.state()?.state === "connected"), JSON.stringify(a.state()));
    const orphan = a.state().pid;
    a.p.kill("SIGKILL");
    await until(() => a.p.exitCode !== null || a.p.signalCode);
    // On Windows, Node ties a child to its parent (a job object), so a
    // force-closed app takes its tunnel with it; elsewhere the tunnel is left
    // behind and the next start must clean it up.
    const tiedToApp = process.platform === "win32" && !alive(orphan);
    assert.ok(tiedToApp || alive(orphan), "its tunnel survived the force-close");
    // A record that names an unrelated process (same id reused) is left alone.
    const list = owned(s.home);
    list.push({ ...remember(stranger.pid), started: "not-its-start-time", owner: 999999 });
    writeFileSync(join(s.home, "owned-tunnels.json"), JSON.stringify(list));
    const c = s.make();
    const recovered = await c.init();
    assert.deepEqual(recovered.map((r) => r.result).sort(), tiedToApp ? ["gone", "not-ours"] : ["not-ours", "stopped"]);
    assert.ok(!alive(orphan), "the orphaned tunnel was stopped by recovery itself");
    assert.ok(alive(stranger.pid), "an unrelated process is untouched");
    assert.ok(await until(() => c.state.state === "connected"));
    assert.equal(liveTunnels(s.home).length, 1);
    await c.shutdown();
  } finally { stranger.kill(); s.clean(); }
});

test("two starts at the same moment run one tunnel", async () => {
  const s = setup({ control: { readyz: 200, controlPlane: { status: "ok" } } });
  const a = connectionProcess(s), b = connectionProcess(s);
  try {
    assert.ok(await until(() => a.state() && b.state() && [a.state().state, b.state().state].includes("connected")));
    await sleep(800);
    const states = [a.state().state, b.state().state].sort();
    assert.deepEqual(states, ["connected", "failed"], JSON.stringify(states));
    assert.match([a.state(), b.state()].find((x) => x.state === "failed").detail, /already managing/);
    assert.equal(liveTunnels(s.home).length, 1);
  } finally {
    a.p.kill("SIGKILL"); b.p.kill("SIGKILL");
    await sleep(200);
    for (const r of owned(s.home)) if (isSame(r)) process.kill(-r.pid);
    s.clean();
  }
});

test("after sleep, a tunnel that doesn't recover is replaced", async () => {
  const s = setup({ control: { readyz: 200, controlPlane: { status: "ok" } } });
  await s.creds.set(KEY_NAME(TUNNEL), KEY);
  const c = s.make();
  try {
    await c.init();
    assert.ok(await until(() => c.state.state === "connected"));
    const first = c.state.pid;
    s.ctl({ readyz: 200, controlPlane: { status: "degraded", reason_code: "network_unreachable" } });
    c.onResume();
    assert.ok(await until(() => c.state.pid !== first, 6000), "replaced after waking");
    s.ctl({ readyz: 200, controlPlane: { status: "ok" } });
    assert.ok(await until(() => c.state.state === "connected"));
  } finally { await c.shutdown(); s.clean(); }
});

// A stand-in simulator for the hub: no browser, just timings and a recording.
function fakeBridge() {
  const b = { open: false, calls: [], info: { simulator: {} } };
  b.running = () => b.open;
  b.call = async (name, args) => {
    b.calls.push(name);
    const ok = (o) => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, ...o }) }] });
    if (name === "rudi_status") return ok({ running: b.open });
    if (name === "rudi_start") { if (b.open) throw new Error("Stop the current simulator first"); b.open = true; return ok({ did: "start" }); }
    if (!b.open) throw new Error("No simulator owned by this bridge is running");
    if (name === "rudi_action") { await sleep(args.args?.[0] === "slow" ? 600 : 20); return ok({ did: args.action }); }
    if (name === "rudi_stop") { await sleep(100); b.open = false; return ok({ recording: { folder: "/rec/x", video: "/rec/x/v.webm", finalized: true } }); }
  };
  return b;
}
const text = (r) => r.content.map((c) => c.text).join("\n");

test("hub: one owner at a time, clear conflicts, and taking over only from a client that has gone", async () => {
  const home = mkdtempSync(join(tmpdir(), "rudi-hub-"));
  const hub = new Hub({ bridge: fakeBridge(), home });
  const claude = { id: "claude:1", kind: "claude", pid: process.pid, name: "claude-code" };
  const gone = spawn(process.execPath, ["-e", "0"]); await new Promise((r) => gone.once("exit", r));
  const chatgpt = { id: "chatgpt:2", kind: "chatgpt", pid: process.pid };
  try {
    assert.ok(!(await hub.call(claude, "rudi_start", { url: "http://localhost:1" })).isError);
    const conflict = await hub.call(chatgpt, "rudi_action", { action: "look" });
    assert.ok(conflict.isError); assert.match(text(conflict), /in use by Claude Code/);
    assert.match(text(await hub.call(chatgpt, "rudi_status")), /in use by Claude Code/);
    assert.ok(!(await hub.call(claude, "rudi_action", { action: "look" })).isError, "the owner carries on");
    // ChatGPT's connection restarts: a new bridge process is still ChatGPT.
    await hub.call(claude, "rudi_stop");
    await hub.call(chatgpt, "rudi_start", { url: "http://localhost:1" });
    assert.ok(!(await hub.call({ ...chatgpt, id: "chatgpt:3" }, "rudi_action", { action: "look" })).isError);
    await hub.call(chatgpt, "rudi_stop");
    // An owner whose process has ended: the next client continues and is told.
    await hub.call({ ...claude, pid: gone.pid }, "rudi_start", { url: "http://localhost:1" });
    const took = await hub.call(chatgpt, "rudi_action", { action: "look" });
    assert.ok(!took.isError); assert.match(text(took), /no longer connected/);
    // Calls never overlap.
    const order = [];
    await Promise.all([hub.call(chatgpt, "rudi_action", { action: "look", args: ["slow"] }).then(() => order.push("slow")), sleep(50).then(() => hub.call(chatgpt, "rudi_action", { action: "look" })).then(() => order.push("fast"))]);
    assert.deepEqual(order, ["slow", "fast"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("disconnect during an action and a recording: the action finishes, the recording is finalized, ChatGPT is refused, Claude still works", async () => {
  const s = setup({ control: { readyz: 200, controlPlane: { status: "ok" } } });
  await s.creds.set(KEY_NAME(TUNNEL), KEY);
  const bridge = fakeBridge();
  const hub = new Hub({ bridge, home: s.home });
  const c = s.make({ hub });
  const chatgpt = { id: "chatgpt:1", kind: "chatgpt", pid: process.pid };
  try {
    await c.init();
    assert.ok(await until(() => c.state.state === "connected"));
    await hub.call(chatgpt, "rudi_start", { url: "http://localhost:1" });
    const slow = hub.call(chatgpt, "rudi_action", { action: "look", args: ["slow"] });
    await sleep(50);
    const report = await c.disconnect();
    assert.ok(!(await slow).isError, "the action already running finished");
    assert.equal(report.inFlight, 0);
    assert.equal(report.recording?.finalized, true, "ChatGPT's recording was finished before the tunnel stopped");
    assert.equal(bridge.open, false);
    const refused = await hub.call(chatgpt, "rudi_status");
    assert.ok(refused.isError); assert.match(text(refused), /disconnected from ChatGPT/);
    assert.ok(!(await hub.call({ id: "claude:9", kind: "claude", pid: process.pid }, "rudi_start", { url: "http://localhost:1" })).isError, "local Claude still works");
    assert.equal(liveTunnels(s.home).length, 0);
  } finally { await c.shutdown(); s.clean(); }
});

test("end to end: ChatGPT's calls arrive through the tunnel at the bridge program and reach the app's hub", async () => {
  const s = setup({ control: { readyz: 200, controlPlane: { status: "ok" } } });
  await s.creds.set(KEY_NAME(TUNNEL), KEY);
  const hub = new Hub({ bridge: fakeBridge(), home: s.home });
  await hub.listen();
  const server = fileURLToPath(new URL("../local-bridge/server.mjs", import.meta.url));
  const c = s.make({ hub, mcpCommand: `"${process.execPath}" "${server}" --client chatgpt --hub-only`, env: { ...process.env, FAKE_TUNNEL_CONTROL: join(s.home, "control.json"), RUDI_SIM_DESKTOP_HOME: s.home } });
  try {
    await c.init();
    assert.ok(await until(() => c.state.state === "connected"));
    const base = readFileSync(owned(s.home)[0].marker, "utf8").trim();
    const rpc = (m) => fetch(`${base}/fake/rpc`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", ...m }) }).then((r) => (r.status === 204 ? null : r.json()));
    const init = await rpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "openai-mcp", version: "1" } } });
    assert.equal(init.result.serverInfo.name, "rudi-sim-local-bridge");
    await rpc({ method: "notifications/initialized" });
    const start = await rpc({ id: 2, method: "tools/call", params: { name: "rudi_start", arguments: { url: "http://localhost:5000" } } });
    assert.ok(!start.result.isError, JSON.stringify(start));
    assert.equal(hub.status().simulator.ownerKind, "chatgpt");
    assert.ok(hub.status().clients.some((x) => x.kind === "chatgpt"), "the app sees ChatGPT connected");
    const bad = await rpc({ id: 3, method: "tools/call", params: { name: "rudi_start", arguments: { url: "file:///etc/passwd" } } });
    assert.ok(bad.result.isError, "the bridge still checks every argument before forwarding");
  } finally { await c.shutdown(); hub.close(); s.clean(); }
});

test("after Disconnect, both Connect and Restart give ChatGPT its tools back (a real tool call through the tunnel), Claude works throughout", async () => {
  const s = setup({ control: { readyz: 200, controlPlane: { status: "ok" } } });
  await s.creds.set(KEY_NAME(TUNNEL), KEY);
  const hub = new Hub({ bridge: fakeBridge(), home: s.home });
  await hub.listen();
  const server = fileURLToPath(new URL("../local-bridge/server.mjs", import.meta.url));
  const c = s.make({ hub, mcpCommand: `"${process.execPath}" "${server}" --client chatgpt --hub-only`, env: { ...process.env, FAKE_TUNNEL_CONTROL: join(s.home, "control.json"), RUDI_SIM_DESKTOP_HOME: s.home } });
  const claude = { id: "claude:7", kind: "claude", pid: process.pid };
  // ChatGPT's side: a fresh MCP session through whichever tunnel is running now.
  const chatgptCalls = async (name, args = {}) => {
    const base = readFileSync(liveTunnels(s.home)[0].marker, "utf8").trim();
    let id = 0;
    const rpc = (m) => fetch(`${base}/fake/rpc`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", ...m }) }).then((r) => (r.status === 204 ? null : r.json()));
    await rpc({ id: ++id, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "openai-mcp", version: "1" } } });
    await rpc({ method: "notifications/initialized" });
    return (await rpc({ id: ++id, method: "tools/call", params: { name, arguments: args } })).result;
  };
  const claudeWorks = async () => !(await hub.call(claude, "rudi_status")).isError;
  try {
    await c.init();
    assert.ok(await until(() => c.state.state === "connected"));
    assert.ok(!(await chatgptCalls("rudi_status")).isError, "ChatGPT works before Disconnect");

    for (const how of ["connect", "restart"]) {
      await c.disconnect();
      assert.equal(hub.remote, false);
      assert.match(text(await hub.call({ id: "chatgpt:1", kind: "chatgpt" }, "rudi_status")), /disconnected from ChatGPT/);
      assert.ok(await claudeWorks(), `Claude works while disconnected (before ${how})`);
      await c[how]();
      assert.ok(await until(() => c.state.state === "connected"), `${how}: ${JSON.stringify(c.state)}`);
      const r = await chatgptCalls("rudi_start", { url: "http://localhost:5000" });
      assert.ok(!r.isError, `ChatGPT can use its tools again after Disconnect → ${how}: ${JSON.stringify(r)}`);
      assert.equal(hub.status().simulator.ownerKind, "chatgpt");
      assert.ok(!(await chatgptCalls("rudi_stop")).isError);
      assert.ok(await claudeWorks(), `Claude works after ${how}`);
      assert.equal(liveTunnels(s.home).length, 1);
    }

    // A Disconnect is remembered: after the app restarts, ChatGPT stays shut out
    // until Connect, while Claude keeps working.
    await c.disconnect();
    await c.shutdown();
    const hub2 = new Hub({ bridge: fakeBridge(), home: s.home });
    hub2.setRemote(s.settings.get().intent !== "disconnected"); // what the app does on start
    const c2 = s.make({ hub: hub2 });
    await c2.init();
    assert.equal(c2.state.state, "disconnected");
    assert.equal(hub2.remote, false);
    assert.ok(!(await hub2.call(claude, "rudi_status")).isError, "Claude works after the app restarts");
    await c2.connect();
    assert.ok(await until(() => c2.state.state === "connected"));
    assert.equal(hub2.remote, true, "Connect after a restart gives ChatGPT its tools back");
    await c2.shutdown();
  } finally { await c.shutdown(); hub.close(); s.clean(); }
});
