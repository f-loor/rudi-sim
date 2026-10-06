#!/usr/bin/env node
// Checks the installed desktop app the way a computer treats it, with a
// stand-in for OpenAI's tunnel-client (fake-tunnel.mjs):
//
//   1. Opening it twice at once gives one app and one tunnel.
//   2. Force-closing it (Task Manager / kill -9) leaves its tunnel behind; the
//      next start cleans that tunnel up and starts exactly one new one, and
//      leaves alone an unrelated process whose number was in its records.
//   3. "Rudi-Sim --quit" quits it, and nothing it started keeps running.
//
// Usage: node app/test/lifecycle.mjs --app <path to Rudi-Sim.exe or .app/Contents/MacOS/Rudi-Sim> --out <results.json>
//        (from a checkout: --app app/node_modules/electron/dist/electron --dev app)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alive, identify, powershell } from "../../skills/rudi-sim/scripts/proc.mjs";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
const exe = resolve(arg("--app"));
const out = resolve(arg("--out") || "lifecycle.json");
// Developing: Electron itself plus the app folder (and no sandbox when running as root on Linux).
const pre = process.argv.includes("--dev") ? [resolve(arg("--dev")), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])] : [];
const home = process.env.RUDI_SIM_DESKTOP_HOME;
if (!home) throw new Error("Set RUDI_SIM_DESKTOP_HOME to a throwaway folder.");
mkdirSync(home, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(200); } return false; };
const json = (f) => { try { return JSON.parse(readFileSync(join(home, f), "utf8")); } catch { return null; } };
const owned = () => (json("owned-tunnels.json") || []).filter((o) => alive(o.pid));
const appPid = () => { const l = json("service.lock"); return l && alive(l.pid) ? l.pid : null; };
const healthy = async (o) => { try { const base = readFileSync(o.marker, "utf8").trim(); return (await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };

// Every process whose program is this app (the app, its helpers, tunnels and bridges run as Node by it).
function appProcesses() {
  if (process.platform === "win32") {
    const outText = powershell(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${exe.replace(/'/g, "''")}' } | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`, 30000);
    return outText.split(/\r?\n/).filter(Boolean).map((l) => { const [pid, ...c] = l.split("\t"); return { pid: Number(pid), cmd: c.join("\t") }; });
  }
  const r = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return r.stdout.split("\n").map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m[1]), cmd: m[2] })).filter((p) => p.cmd.startsWith(exe));
}
const mains = () => appProcesses().filter((p) => !/--type=|fake-tunnel|server\.mjs|walk\.mjs/.test(p.cmd));
const forceKill = (pid) => (process.platform === "win32" ? spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true }) : process.kill(pid, "SIGKILL"));
const open = (...extra) => { const c = spawn(exe, [...pre, "--hidden", ...extra], { detached: true, stdio: "ignore", env: process.env }); c.unref(); return c; };

const steps = [];
const result = { ok: false, app: exe, platform: `${process.platform}-${process.arch}`, steps };
async function step(name, fn) {
  const t = Date.now();
  try { const detail = await fn(); steps.push({ name, ok: true, ms: Date.now() - t, detail }); console.log(`✓ ${name} (${Date.now() - t} ms)`); }
  catch (e) { steps.push({ name, ok: false, ms: Date.now() - t, error: e.message }); console.log(`✗ ${name}: ${e.message}`); }
  writeFileSync(out, JSON.stringify(result, null, 2));
}
const must = (c, m) => { if (!c) throw new Error(m); };

// A connected ChatGPT setup, with the test key and the stand-in tunnel (see main.mjs).
writeFileSync(join(home, "control.json"), JSON.stringify({ readyz: 200 }));
writeFileSync(join(home, "settings.json"), JSON.stringify({ setupDone: true, use: { claude: true, chatgpt: true }, tunnelId: "tunnel_lifecycle0001", tunnelClient: exe, intent: "connected", keepRunningInBackground: true }));
process.env.RUDI_SIM_CREDENTIAL_PROVIDER = "env-for-tests";
process.env.RUDI_SIM_TEST_KEY = "sk-test-lifecycle-not-real";
process.env.RUDI_SIM_TEST_TUNNEL = JSON.stringify([exe, join(repo, "integrations/desktop/fake-tunnel.mjs")]);
process.env.FAKE_TUNNEL_CONTROL = join(home, "control.json");

let firstTunnel = null, stranger = null;
await step("opening it twice at once gives one app and one tunnel", async () => {
  open(); open();
  must(await until(() => appPid() && owned().length === 1 && healthy(owned()[0])), `app ${appPid()}, tunnels ${owned().length}`);
  await sleep(3000);
  must(mains().length === 1, `${mains().length} app processes: ${JSON.stringify(mains())}`);
  must(owned().length === 1, `${owned().length} tunnels`);
  firstTunnel = owned()[0];
  return { app: appPid(), tunnel: firstTunnel.pid };
});

await step("after a force-close, the next start removes the left-over tunnel and leaves strangers alone", async () => {
  // An unrelated process whose number is in the records (as if a tunnel's number were reused).
  stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await sleep(500);
  const recs = json("owned-tunnels.json");
  recs.push({ pid: stranger.pid, started: "2001-01-01T00:00:00.000Z", marker: join(home, "not-a-tunnel.url") });
  writeFileSync(join(home, "owned-tunnels.json"), JSON.stringify(recs));
  const before = appPid();
  forceKill(before);
  must(await until(() => !alive(before), 15000), "the app didn't die");
  // Windows ends a force-closed app's tunnel along with it (Node puts children
  // in a job object); elsewhere it's left behind and the next start cleans up.
  const tiedToApp = process.platform === "win32" && (await until(() => !alive(firstTunnel.pid), 5000));
  must(tiedToApp || alive(firstTunnel.pid), "the tunnel should still be running after a force-close (that's the case being tested)");
  const t = Date.now();
  open();
  must(await until(() => appPid() && appPid() !== before && owned().some((o) => o.pid !== firstTunnel.pid)), "no new tunnel");
  must(await until(() => !alive(firstTunnel.pid), 15000), "the left-over tunnel is still running");
  must(await until(() => owned().length === 1 && healthy(owned()[0])), `${owned().length} tunnels`);
  must(alive(stranger.pid), "an unrelated process was stopped");
  return { tunnelEndedWithApp: tiedToApp, recoveredMs: Date.now() - t, newTunnel: owned()[0].pid, stranger: identify(stranger.pid)?.pid ?? stranger.pid };
});

await step("Rudi-Sim --quit stops the app and everything it started", async () => {
  const pid = appPid(), tunnel = owned()[0]?.pid;
  spawn(exe, [...pre, "--quit"], { detached: true, stdio: "ignore" }).unref();
  must(await until(() => !alive(pid), 60000), "the app is still running");
  must(await until(() => appProcesses().length === 0, 20000), `still running: ${JSON.stringify(appProcesses())}`);
  must(!tunnel || !alive(tunnel), "the tunnel is still running");
  must(!existsSync(join(home, "service.lock")), "the lock wasn't released");
  return "nothing left running";
});

try { stranger?.kill(); } catch {}
result.ok = steps.every((s) => s.ok);
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(result.ok ? "Lifecycle checks passed." : "Lifecycle checks FAILED.");
process.exit(result.ok ? 0 : 1);
