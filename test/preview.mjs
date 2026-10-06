#!/usr/bin/env node
// Checks preview.mjs: trust, separate checkouts for two git revisions, reusing an
// install, reusing a running preview, port conflicts, crash reports, the reset
// hook, and stopping only what Rudi-Sim started. No browser needed.
// Usage: node test/preview.mjs
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const preview = join(root, "skills", "rudi-sim", "scripts", "preview.mjs");
const tmp = mkdtempSync(join(tmpdir(), "rudi-preview-"));
// Its own Rudi-Sim home, so the trust list and state don't touch the real ones.
const env = { ...process.env, RUDI_SIM_HOME: join(tmp, "home") };
let failures = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) { failures++; if (detail) console.log(String(detail).split("\n").map((l) => "      " + l).join("\n")); } };
const run = (...a) => { const r = spawnSync(process.execPath, [preview, ...a], { env, encoding: "utf8", timeout: 120000 }); return { code: r.status, text: (r.stdout || "") + (r.stderr || "") }; };
const get = (port) => fetch(`http://localhost:${port}/`).then((r) => r.text(), () => null);
const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const extra = [];
process.on("exit", () => { run("stop", project); for (const s of extra) s.close?.() ?? s.kill?.(); rmSync(tmp, { recursive: true, force: true }); });

// A tiny site in a git repository: main says "version A", the feature branch "version B".
const repo = join(tmp, "site");
spawnSync("git", ["init", "-q", "-b", "main", repo]);
git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
const app = (v) => `require("http").createServer((q,s)=>s.end("<h1>version ${v}</h1>")).listen(+process.env.PORT,()=>console.log("up "+process.env.PORT));\n`;
writeFileSync(join(repo, "server.js"), app("A")); writeFileSync(join(repo, "package.json"), '{"name":"site"}\n');
git("add", "."); git("commit", "-qm", "A");
git("checkout", "-qb", "feature"); writeFileSync(join(repo, "server.js"), app("B")); git("commit", "-qam", "B"); git("checkout", "-q", "main");
const P1 = 5511, P2 = 5512;
const project = join(tmp, "rudi-sim.project.json");
const cfg = {
  name: "site", repo: "./site",
  original: { ref: "main" }, proposed: { ref: "feature" },
  install: `node -e "require('fs').appendFileSync('installs.txt','x')"`,
  launch: "node server.js", port: { original: P1, proposed: P2 }, health: "/", readyTimeout: 30,
  reset: `node -e "require('fs').appendFileSync('resets.txt',process.env.RUDI_SIM_SIDE+'\\n')"`,
};
writeFileSync(project, JSON.stringify(cfg, null, 2));

let r = run("start", project);
check(r.code === 1 && /hasn't been allowed to run this project's commands/.test(r.text), "an untrusted project file runs nothing", r.text);
r = run("trust", project);
check(r.code === 0 && /launch: node server.js/.test(r.text), "trust shows the commands it allows", r.text);
r = run("start", project);
check(r.code === 0 && /Original: http:\/\/localhost:5511/.test(r.text), "start runs both versions", r.text);
check((await get(P1))?.includes("version A") && (await get(P2))?.includes("version B"), "original is main and proposed is the feature branch, side by side");
check(git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim() === "main" && git("status", "--porcelain").stdout.trim() === "", "your own checkout is left as it was");
const stateDir = join(env.RUDI_SIM_HOME, "projects", readdirSync(join(env.RUDI_SIM_HOME, "projects"))[0]);
const state = { dir: stateDir, ...JSON.parse(readFileSync(join(stateDir, "previews.json"), "utf8")) };
const installs = (side) => { try { return readFileSync(join(state.sides[side].dir, "installs.txt"), "utf8").length; } catch { return 0; } };
check(installs("original") === 1 && installs("proposed") === 1, "dependencies installed once in each checkout");
check(readFileSync(join(state.sides.original.dir, "resets.txt"), "utf8").trim() === "original" && readFileSync(join(state.sides.proposed.dir, "resets.txt"), "utf8").trim() === "proposed", "the reset hook ran once on each side, told which side it is");
r = run("start", project);
check(r.code === 0 && /already running/.test(r.text) && installs("original") === 1, "starting again reuses the running previews and the install", r.text);
// The proposed branch moves while its preview is running and healthy: only that side restarts, on the new commit.
git("checkout", "-q", "feature"); writeFileSync(join(repo, "server.js"), app("B2")); git("commit", "-qam", "B2"); git("checkout", "-q", "main");
r = run("start", project);
check(r.code === 0 && /proposed: restarting because feature moved/.test(r.text) && /original: already running/.test(r.text), "a branch that moved restarts only that side", r.text);
check((await get(P2))?.includes("version B2") && (await get(P1))?.includes("version A"), "the proposed preview now shows the new commit");
check(git("status", "--porcelain").stdout.trim() === "" && git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim() === "main", "your own checkout is still untouched");
// Changed settings (here an extra environment value) restart both sides, after trusting the file again.
writeFileSync(project, JSON.stringify({ ...cfg, env: { GREETING: "hi" } }, null, 2)); run("trust", project);
r = run("start", project);
check(r.code === 0 && (r.text.match(/restarting because its settings changed/g) || []).length === 2, "changed settings restart both previews", r.text);
// A recorded process id that now belongs to another program is never stopped.
const sides = JSON.parse(readFileSync(join(state.dir, "previews.json"), "utf8"));
const stranger = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); extra.push(stranger);
await sleep(300);
const realOriginal = sides.sides.original;
sides.sides.original = { ...realOriginal, pid: stranger.pid };
writeFileSync(join(state.dir, "previews.json"), JSON.stringify(sides));
r = run("stop", project);
check(/left alone/.test(r.text) && stranger.exitCode === null, "stop leaves a process alone when its id now belongs to another program", r.text);
// Put the real record back so it can be stopped.
writeFileSync(join(state.dir, "previews.json"), JSON.stringify({ sides: { original: realOriginal } }));
r = run("stop", project);
check(r.code === 0 && (await get(P1)) === null && (await get(P2)) === null, "stop ends both previews", r.text);
writeFileSync(project, JSON.stringify(cfg, null, 2)); run("trust", project);
r = run("start", project);
check(r.code === 0 && installs("original") === 1 && /dependencies unchanged/.test(r.text), "a restart doesn't reinstall when nothing changed", r.text);
run("stop", project);

// Someone else's program on the original's port: refuse, and leave it alone.
const other = http.createServer((q, s) => s.end("someone else")); extra.push(other);
await new Promise((ok) => other.listen(P1, ok));
r = run("start", project);
check(r.code === 1 && /already in use by a program Rudi-Sim didn't start/.test(r.text), "a port taken by another program is reported", r.text);
run("stop", project);
check((await get(P1)) === "someone else", "stop leaves programs Rudi-Sim didn't start running");
other.close(); await sleep(200);

// A change to the file needs trusting again.
writeFileSync(project, JSON.stringify({ ...cfg, launch: "node server.js --changed" }, null, 2));
r = run("start", project);
check(r.code === 1 && /changed since you trusted it/.test(r.text), "an edited project file must be trusted again", r.text);

// A launch command that crashes is reported straight away with its log.
writeFileSync(project, JSON.stringify({ ...cfg, launch: `node -e "console.error('boom from the app');process.exit(7)"` }, null, 2));
run("trust", project);
const t = Date.now();
r = run("start", project);
check(r.code === 1 && /stopped while starting \(exit 7\)/.test(r.text) && /boom from the app/.test(r.text) && Date.now() - t < 20000, "a site that crashes while starting is reported with its log, without waiting out the time limit", r.text);

console.log(`\n${failures ? `${failures} check(s) failed` : "All checks passed"}.`);
process.exit(failures ? 1 : 0);

