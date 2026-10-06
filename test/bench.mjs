#!/usr/bin/env node
// Times a Before/After session: start until ready, then common steps.
// Usage: node test/bench.mjs [--engine webkit|chromium] [--runs 3] [--walk <other walk.mjs>] [--json <file>]
// Prints the median of each timing in milliseconds. Uses only the public CLI,
// so the same script measures any version of walk.mjs.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
// --walk measures another copy (for example main's, to compare before and after a change).
const walk = arg("--walk", join(root, "skills", "rudi-sim", "scripts", "walk.mjs"));
const engine = arg("--engine", "webkit"), runs = Number(arg("--runs", 3));
const P1 = 5181, P2 = 5182;
const servers = [P1, P2].map((p) => spawn(process.execPath, [join(root, "test", "server.mjs"), String(p)], { stdio: "ignore" }));
process.on("exit", () => servers.forEach((s) => s.kill()));
await new Promise((r) => setTimeout(r, 800));

const home = mkdtempSync(join(tmpdir(), "rudi-bench-"));
const env = { ...process.env, RUDI_SIM_HOME: process.env.RUDI_SIM_HOME || join(process.env.HOME || process.env.USERPROFILE, ".rudi-sim") };
const steps = [["look"], ["click", "Café ☕ “quotes”"], ["scroll", "down"], ["goto", "/long"], ["scroll", "bottom"], ["back"], ["goto", "/login"], ["click", "Log me in"]];
const times = {};
const add = (k, ms) => (times[k] ||= []).push(ms);
for (let run = 0; run < runs; run++) {
  const out = join(home, `run-${run}`);
  const t0 = Date.now();
  const child = spawn(process.execPath, [walk, "start", `localhost:${P1}`, "--compare", `localhost:${P2}`, "--device", "iPhone SE, iPad mini", "--headless", "--engine", engine, "--slow", "100", "--out", out], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  await new Promise((ok, fail) => {
    child.stdout.on("data", (d) => { log += d; if (log.includes("READY")) ok(); });
    child.stderr.on("data", (d) => (log += d));
    child.once("exit", () => fail(new Error(log)));
  });
  add("start → ready", Date.now() - t0);
  for (const s of steps) {
    const t = Date.now();
    const r = spawnSync(process.execPath, [walk, "do", ...s], { env, encoding: "utf8" });
    if (r.status !== 0) console.error(`step ${s.join(" ")} exit ${r.status}: ${(r.stdout + r.stderr).trim().split("\n")[0]}`);
    add(s.join(" ").slice(0, 22), Date.now() - t);
  }
  const t = Date.now();
  spawnSync(process.execPath, [walk, "stop"], { env, encoding: "utf8" });
  await new Promise((ok) => (child.exitCode !== null ? ok() : child.once("exit", ok)));
  add("stop (video saved)", Date.now() - t);
}
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`engine=${engine} runs=${runs} devices="iPhone SE, iPad mini" compare=on (4 panes)`);
for (const [k, v] of Object.entries(times)) console.log(`${k.padEnd(22)} median ${String(median(v)).padStart(6)} ms   (${v.join(", ")})`);
if (arg("--json")) writeFileSync(arg("--json"), JSON.stringify({ engine, runs, walk, medians: Object.fromEntries(Object.entries(times).map(([k, v]) => [k, median(v)])), times }, null, 2));
rmSync(home, { recursive: true, force: true });
process.exit(0);
