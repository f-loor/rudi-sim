#!/usr/bin/env node
// Runs the original and proposed versions of a project side by side, from a
// project file you write and trust yourself, then opens the Before/After window.
//
//   node preview.mjs init [--file rudi-sim.project.json]   write an example project file
//   node preview.mjs trust <project file>                  allow Rudi-Sim to run its commands
//   node preview.mjs start <project file> [--open] [--fresh-install]
//   node preview.mjs status [<project file>] [--json]
//   node preview.mjs stop <project file>
//   node preview.mjs reset <project file>                  run its demo reset/seed hook on both
//
// Commands only ever come from a project file on this computer that you trusted
// with `trust`; never from a website, a page Rudi-Sim opened, or a chat message.
// If the file changes, it has to be trusted again.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alive, isSame, killTree, remember, stopOwned } from "./proc.mjs";
export { alive, killTree };

const HOME = process.env.RUDI_SIM_HOME || join(homedir(), ".rudi-sim");
const TRUST = join(HOME, "trusted-projects.json");
const SIDES = ["original", "proposed"];
// "proposed": { "ref": "WORKTREE" } runs your working folder itself, so edits show up live.
export const WORKTREE = "WORKTREE";

export const EXAMPLE = {
  name: "my-site",
  repo: ".",
  original: { ref: "main" },
  proposed: { ref: WORKTREE },
  install: "npm install",
  launch: "npm run dev -- --port {port}",
  port: { original: 5101, proposed: 5102 },
  health: "/",
  readyTimeout: 120,
  env: {},
  reset: null,
};

// ---- project files ----
export function loadProject(file) {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`No project file at ${path}. Make one with: node preview.mjs init`);
  const text = readFileSync(path, "utf8");
  let cfg;
  try { cfg = JSON.parse(text); } catch (e) { throw new Error(`${path} isn't valid JSON: ${e.message}`); }
  const problems = [];
  if (!cfg.name || !/^[a-z0-9][a-z0-9._-]{0,59}$/i.test(cfg.name)) problems.push('"name": letters, numbers, dot, dash or underscore');
  for (const side of SIDES) {
    const s = cfg[side];
    if (!s || (!s.ref && !s.url) || (s.ref && s.url)) { problems.push(`"${side}": give either { "ref": "<branch, tag or commit>" } or { "url": "http://..." }`); continue; }
    if (s.url && !/^https?:\/\//i.test(s.url)) problems.push(`"${side}.url" must start with http:// or https://`);
    if (s.ref && !/^[A-Za-z0-9._\/-]{1,200}$/.test(s.ref)) problems.push(`"${side}.ref" has characters a git ref can't have`);
  }
  const needsRun = SIDES.some((side) => cfg[side]?.ref);
  if (needsRun) {
    if (typeof cfg.launch !== "string" || !cfg.launch.trim()) problems.push('"launch": the command that starts the site, e.g. "npm run dev -- --port {port}"');
    for (const side of SIDES) if (cfg[side]?.ref && !Number.isInteger(portFor(cfg, side))) problems.push(`"port": a port for ${side}, e.g. { "original": 5101, "proposed": 5102 }`);
    if (portFor(cfg, "original") === portFor(cfg, "proposed") && SIDES.every((s) => cfg[s]?.ref)) problems.push('"port": original and proposed need different ports');
  }
  for (const k of ["install", "reset"]) if (cfg[k] != null && typeof cfg[k] !== "string") problems.push(`"${k}" must be a command (text) or null`);
  if (cfg.env && (typeof cfg.env !== "object" || Object.values(cfg.env).some((v) => typeof v !== "string"))) problems.push('"env": names and text values');
  if (problems.length) throw new Error(`${path} needs fixing:\n  - ${problems.join("\n  - ")}`);
  const repo = resolve(dirname(path), cfg.repo || ".");
  return { ...cfg, path, repo, hash: hashText(text), stateDir: join(HOME, "projects", `${cfg.name}-${hashText(path).slice(0, 8)}`) };
}

function portFor(cfg, side) { return typeof cfg.port === "number" ? cfg.port + (side === "proposed" ? 1 : 0) : cfg.port?.[side]; }
function hashText(t) { return createHash("sha256").update(t).digest("hex"); }

// ---- trust: you approve a project file, by its exact contents ----
function readTrust() { try { return JSON.parse(readFileSync(TRUST, "utf8")); } catch { return {}; } }
export function trust(file) {
  const cfg = loadProject(file);
  const t = readTrust();
  t[cfg.path] = { hash: cfg.hash, name: cfg.name, at: new Date().toISOString() };
  mkdirSync(HOME, { recursive: true });
  writeFileSync(TRUST, JSON.stringify(t, null, 2));
  return cfg;
}
export function isTrusted(cfg) { return readTrust()[cfg.path]?.hash === cfg.hash; }
export function requireTrusted(cfg) {
  if (isTrusted(cfg)) return;
  const was = readTrust()[cfg.path];
  throw new Error(`${was ? "This project file changed since you trusted it" : "Rudi-Sim hasn't been allowed to run this project's commands"}: ${cfg.path}\n` +
    `Read it, then allow it with: node "${fileURLToPath(import.meta.url)}" trust "${cfg.path}"`);
}
// Trusted projects by name, for tools that may only name one (the bridge).
export function trustedProjects() {
  return Object.entries(readTrust()).map(([path, t]) => ({ path, name: t.name })).filter((p) => existsSync(p.path));
}

// ---- state: which processes Rudi-Sim started, so it stops only those ----
function statePath(cfg) { return join(cfg.stateDir, "previews.json"); }
export function readState(cfg) { try { return JSON.parse(readFileSync(statePath(cfg), "utf8")); } catch { return { sides: {} }; } }
function writeState(cfg, s) { mkdirSync(cfg.stateDir, { recursive: true }); writeFileSync(statePath(cfg), JSON.stringify(s, null, 2)); }

// Is something answering on this port (on localhost, IPv4 or IPv6)?
export function portInUse(port) {
  const tryHost = (host) => new Promise((ok) => {
    const s = net.connect({ port, host });
    s.once("connect", () => { s.destroy(); ok(true); });
    s.once("error", () => ok(false));
    s.setTimeout(800, () => { s.destroy(); ok(false); });
  });
  return Promise.all([tryHost("127.0.0.1"), tryHost("::1")]).then((r) => r.some(Boolean));
}

// Waits for the site to answer its health address, while watching that the process
// is still running, so a crash is reported at once instead of after the time limit.
export async function waitHealthy(url, { timeoutMs = 120000, child = null, log = null } = {}) {
  const end = Date.now() + timeoutMs;
  let delay = 200, last = "";
  while (Date.now() < end) {
    if (child && child.exitCode !== null) throw new Error(`The site stopped while starting (exit ${child.exitCode}).${log ? `\nLast lines of its log (${log}):\n${tail(log)}` : ""}`);
    try {
      const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3000) });
      if (r.status < 500) return { status: r.status, ms: timeoutMs - (end - Date.now()) };
      last = `answered ${r.status}`;
    } catch (e) { last = e.cause?.code || e.message; }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(2000, delay * 1.5);
  }
  throw new Error(`The site didn't answer ${url} within ${Math.round(timeoutMs / 1000)}s (last: ${last}).${log ? `\nLast lines of its log (${log}):\n${tail(log)}` : ""}`);
}
function tail(file, n = 15) {
  try {
    const size = statSync(file).size, len = Math.min(size, 8192), buf = Buffer.alloc(len), fd = openSync(file, "r");
    readSync(fd, buf, 0, len, size - len); closeSync(fd);
    return buf.toString("utf8").split(/\r?\n/).slice(-n).join("\n");
  } catch { return "(no log)"; }
}


// ---- checkouts ----
function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}`);
  return r.stdout.trim();
}
// The folder a side runs from: your working folder for WORKTREE, otherwise a
// separate git worktree outside your repository, so your own checkout is untouched.
// The commit a side's branch, tag or commit points at right now.
export function resolveRef(cfg, side) {
  const ref = cfg[side].ref;
  return ref === WORKTREE ? null : git(["rev-parse", "--verify", `${ref}^{commit}`], cfg.repo);
}
export function checkout(cfg, side, sha = resolveRef(cfg, side)) {
  if (cfg[side].ref === WORKTREE) return { dir: cfg.repo, live: true };
  const dir = join(cfg.stateDir, "worktrees", side);
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true });
    git(["worktree", "add", "--detach", dir, sha], cfg.repo);
  } else if (git(["rev-parse", "HEAD"], dir) !== sha) {
    // Rudi-Sim's own copy; if someone edited files in it, keep them and say so.
    if (git(["status", "--porcelain", "--untracked-files=no"], dir)) throw new Error(`${side}: Rudi-Sim's copy of ${cfg[side].ref} at ${dir} has edited files, so it wasn't moved to the new commit. Save or discard those edits, then start again.`);
    git(["checkout", "--detach", "--quiet", sha], dir);
  }
  return { dir, sha, live: false };
}

// Everything that decides what a running preview is. If any of it changed, the
// running one is out of date and is started again.
export function fingerprint(cfg, side) {
  const pick = { side, ref: cfg[side].ref, launch: cfg.launch, install: cfg.install ?? null, env: cfg.env || {}, port: portFor(cfg, side), health: cfg.health || "/", repo: cfg.repo };
  return createHash("sha256").update(JSON.stringify(pick)).digest("hex").slice(0, 16);
}

// Dependencies are installed again only when the files that pin them change.
const LOCKS = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "package.json", "requirements.txt", "poetry.lock", "Pipfile.lock", "Gemfile.lock", "composer.lock"];
export function lockHash(dir) {
  const h = createHash("sha256");
  for (const f of LOCKS) if (existsSync(join(dir, f))) h.update(f).update(readFileSync(join(dir, f)));
  return h.digest("hex");
}

function sub(cmd, vars) { return cmd.replace(/\{(port|side|url)\}/g, (_, k) => String(vars[k])); }

// Runs a trusted project-file command through the system shell, so it works like
// typing it in a terminal (npm, pnpm, python...). Never given text from a website.
// A site that must outlive this command is detached on every system: on Windows,
// Node otherwise ends the shell when this process exits, orphaning the site
// itself so it could no longer be found or stopped.
// On Windows a detached program has no console, and what a site prints there
// can be lost whether it goes to handed-down file handles or a shell redirect.
// So a small Node helper (this same runtime) runs the command, reads its output
// through pipes and appends it to the log itself. Stopping the helper's process
// tree stops the site too. The helper's command line carries `marker`, so it can
// be recognised later.
const WIN_LOGGER = `const{spawn}=require("child_process"),fs=require("fs"),e={...process.env},log=e.RUDI_SIM_LOG,cmd=e.RUDI_SIM_CMD;
delete e.RUDI_SIM_LOG;delete e.RUDI_SIM_CMD;if(e.RUDI_SIM_DROP_RUN_AS_NODE)delete e.ELECTRON_RUN_AS_NODE;delete e.RUDI_SIM_DROP_RUN_AS_NODE;
const w=(d)=>{try{fs.appendFileSync(log,d)}catch{}};
const c=spawn(cmd,{env:e,shell:true,stdio:["ignore","pipe","pipe"],windowsHide:true});
c.stdout.on("data",w);c.stderr.on("data",w);c.on("error",(x)=>{w(String(x.message)+"\\n");process.exit(1)});
c.on("close",(code)=>process.exit(code??1));`;

function runCommand(cmd, { cwd, env, log, detached = false, marker = null }) {
  if (detached && process.platform === "win32") {
    const helperEnv = { ...env, RUDI_SIM_LOG: log, RUDI_SIM_CMD: cmd };
    if (process.versions.electron && !env.ELECTRON_RUN_AS_NODE) Object.assign(helperEnv, { ELECTRON_RUN_AS_NODE: "1", RUDI_SIM_DROP_RUN_AS_NODE: "1" });
    return spawn(process.execPath, ["-e", WIN_LOGGER, "--", "rudi-sim-preview", marker || "site"], { cwd, env: helperEnv, stdio: "ignore", detached, windowsHide: true });
  }
  const out = openSync(log, "a");
  const child = spawn(cmd, { cwd, env, shell: true, stdio: ["ignore", out, out], detached, windowsHide: true });
  closeSync(out);
  return child;
}

// ---- start / stop ----
export async function start(cfg, { freshInstall = false, say = console.log } = {}) {
  requireTrusted(cfg);
  const state = readState(cfg);
  const result = {};
  for (const side of SIDES) {
    const s = cfg[side];
    if (s.url) { result[side] = { url: s.url, owned: false }; continue; }
    const port = portFor(cfg, side), url = `http://localhost:${port}`;
    const health = new URL(cfg.health || "/", url).href;
    const mine = state.sides[side];
    const sha = resolveRef(cfg, side), fp = fingerprint(cfg, side);
    const ours = !!mine && isSame(mine);
    // Already running from an earlier start, still the same settings and commit, and healthy: reuse it.
    // (Your working folder is never "out of date": its site reloads edits itself.)
    const why = !ours ? null : mine.fingerprint !== fp ? "its settings changed" : sha && mine.sha !== sha ? `${s.ref} moved from ${String(mine.sha).slice(0, 8)} to ${sha.slice(0, 8)}` : null;
    if (ours && !why && await portInUse(port)) {
      try { await waitHealthy(health, { timeoutMs: 5000 }); say(`${side}: already running on ${url}`); result[side] = { url, owned: true, pid: mine.pid, reused: true }; continue; } catch {}
    }
    if (ours) {
      say(`${side}: restarting${why ? ` because ${why}` : ""}`);
      await stopOwned(mine);
      // A process that was just stopped can hold its port for a moment.
      for (let i = 0; i < 25 && await portInUse(mine.port); i++) await new Promise((r) => setTimeout(r, 200));
    }
    if (await portInUse(port)) throw new Error(`Port ${port} (${side}) is already in use by a program Rudi-Sim didn't start. Stop that program or change "port" in ${cfg.path}.`);
    const co = checkout(cfg, side, sha);
    const logs = join(cfg.stateDir, "logs"); mkdirSync(logs, { recursive: true });
    const env = { ...process.env, ...(cfg.env || {}), PORT: String(port), RUDI_SIM_SIDE: side };
    const lh = lockHash(co.dir);
    const installedMark = join(cfg.stateDir, `installed-${side}.json`);
    let installed = null; try { installed = JSON.parse(readFileSync(installedMark, "utf8")); } catch {}
    if (cfg.install && (freshInstall || installed?.lock !== lh || installed?.dir !== co.dir)) {
      say(`${side}: installing dependencies (${cfg.install})…`);
      const t = Date.now();
      const c = runCommand(sub(cfg.install, { port, side, url }), { cwd: co.dir, env, log: join(logs, `${side}-install.log`) });
      const code = await new Promise((ok) => c.once("exit", ok));
      if (code !== 0) throw new Error(`${side}: "${cfg.install}" failed (exit ${code}). Log: ${join(logs, `${side}-install.log`)}\n${tail(join(logs, `${side}-install.log`))}`);
      writeFileSync(installedMark, JSON.stringify({ lock: lh, dir: co.dir, at: new Date().toISOString(), ms: Date.now() - t }));
    } else if (cfg.install) say(`${side}: dependencies unchanged since the last install; reusing them`);
    const log = join(logs, `${side}.log`);
    say(`${side}: starting ${co.live ? "your working folder (edits show up live if the site reloads itself)" : `${s.ref} (${co.sha.slice(0, 8)})`} on ${url}`);
    const launch = sub(cfg.launch, { port, side, url });
    // Recognised later by its start time and a piece of its command line: the
    // launch command itself, or on Windows the helper's own tag for this side.
    const marker = process.platform === "win32" ? `${basename(cfg.stateDir)}:${side}` : launch.slice(0, 120);
    const child = runCommand(launch, { cwd: co.dir, env, log, detached: true, marker });
    child.unref();
    state.sides[side] = { ...remember(child.pid, marker), port, url, ref: s.ref, sha: co.sha || null, fingerprint: fp, dir: co.dir, startedAt: new Date().toISOString(), log };
    writeState(cfg, state);
    try { const h = await waitHealthy(health, { timeoutMs: (cfg.readyTimeout || 120) * 1000, child, log }); say(`${side}: ready (${h.status}) after ${(h.ms / 1000).toFixed(1)}s`); }
    catch (e) { killTree(child.pid); delete state.sides[side]; writeState(cfg, state); throw e; }
    result[side] = { url, owned: true, pid: child.pid };
  }
  if (cfg.reset) await reset(cfg, { say, urls: result });
  return result;
}

export async function reset(cfg, { say = console.log, urls = null } = {}) {
  requireTrusted(cfg);
  if (!cfg.reset) throw new Error(`${cfg.path} has no "reset" command.`);
  const state = readState(cfg);
  for (const side of SIDES) {
    const url = urls?.[side]?.url || state.sides[side]?.url || cfg[side].url;
    const port = url ? Number(new URL(url).port) || "" : "";
    const dir = state.sides[side]?.dir || cfg.repo;
    const logs = join(cfg.stateDir, "logs"); mkdirSync(logs, { recursive: true });
    say(`${side}: resetting demo data (${cfg.reset})`);
    const c = runCommand(sub(cfg.reset, { port, side, url }), { cwd: dir, env: { ...process.env, ...(cfg.env || {}), PORT: String(port), RUDI_SIM_SIDE: side, RUDI_SIM_URL: url || "" }, log: join(logs, `${side}-reset.log`) });
    const code = await new Promise((ok) => c.once("exit", ok));
    if (code !== 0) throw new Error(`${side}: reset failed (exit ${code}). Log: ${join(logs, `${side}-reset.log`)}`);
  }
}

export async function stop(cfg, { say = console.log } = {}) {
  const state = readState(cfg);
  let n = 0;
  for (const side of SIDES) {
    const s = state.sides[side];
    if (!s) continue;
    const r = await stopOwned(s);
    if (r === "stopped") { n++; say(`${side}: stopped (process ${s.pid})`); }
    else if (r === "not-ours") say(`${side}: process ${s.pid} is no longer the one Rudi-Sim started, so it was left alone`);
    else if (r === "still-running") say(`${side}: process ${s.pid} didn't stop`);
    delete state.sides[side];
  }
  writeState(cfg, state);
  if (!n) say("Nothing of this project's was running.");
  return n;
}

export async function status(cfg) {
  const state = readState(cfg);
  const out = { project: cfg.name, file: cfg.path, trusted: isTrusted(cfg), sides: {} };
  for (const side of SIDES) {
    const s = state.sides[side];
    if (cfg[side].url) { out.sides[side] = { url: cfg[side].url, owned: false }; continue; }
    out.sides[side] = s ? { url: s.url, running: isSame(s) && await portInUse(s.port), pid: s.pid, ref: s.ref, sha: s.sha, log: s.log } : { running: false };
  }
  return out;
}

// ---- command line ----
async function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (n) => rest.includes(n);
  const file = rest.find((a) => !a.startsWith("--") && rest[rest.indexOf(a) - 1] !== "--file") || "rudi-sim.project.json";
  try {
    if (cmd === "init") {
      const f = resolve(rest.includes("--file") ? rest[rest.indexOf("--file") + 1] : "rudi-sim.project.json");
      if (existsSync(f)) throw new Error(`${f} already exists.`);
      writeFileSync(f, JSON.stringify(EXAMPLE, null, 2) + "\n");
      console.log(`Wrote ${f}. Edit it, then allow it with: node "${fileURLToPath(import.meta.url)}" trust "${f}"\nKeep it out of git if it has anything private: add ${basename(f)} to .gitignore.`);
    } else if (cmd === "trust") {
      const cfg = trust(file);
      console.log(`Trusted ${cfg.path}. Rudi-Sim may now run its commands:\n${["install", "launch", "reset"].filter((k) => cfg[k]).map((k) => `  ${k}: ${cfg[k]}`).join("\n")}\nIf the file changes, it will ask again.`);
    } else if (cmd === "start") {
      const cfg = loadProject(file);
      const r = await start(cfg, { freshInstall: flag("--fresh-install") });
      console.log(`Original: ${r.original.url}\nProposed: ${r.proposed.url}`);
      if (flag("--open")) {
        const walk = join(dirname(fileURLToPath(import.meta.url)), "walk.mjs");
        const extra = rest.includes("--device") ? ["--device", rest[rest.indexOf("--device") + 1]] : [];
        console.log("Opening the Before/After window…");
        const c = spawn(process.execPath, [walk, "start", r.original.url, "--compare", r.proposed.url, "--name", cfg.name, ...extra], { stdio: "inherit" });
        await new Promise((ok) => c.once("exit", ok));
      }
    } else if (cmd === "stop") await stop(loadProject(file));
    else if (cmd === "reset") await reset(loadProject(file));
    else if (cmd === "status") {
      const projects = rest.some((a) => !a.startsWith("--")) ? [loadProject(file)] : trustedProjects().map((p) => loadProject(p.path));
      const all = await Promise.all(projects.map(status));
      if (flag("--json")) console.log(JSON.stringify(all, null, 2));
      else if (!all.length) console.log("No trusted projects yet. Make one with: node preview.mjs init");
      else for (const s of all) console.log(`${s.project}${s.trusted ? "" : " (not trusted)"}\n${Object.entries(s.sides).map(([k, v]) => `  ${k}: ${v.url || "-"} ${v.owned === false ? "(already running elsewhere)" : v.running ? "running" : "stopped"}`).join("\n")}`);
    } else {
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 16).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      process.exit(cmd ? 2 : 0);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
