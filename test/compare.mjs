#!/usr/bin/env node
// Regression checks for the Before/After window: an https site beside an http
// one in both orders, a site that isn't running, a page slower than the time
// allowed, a step that works on one side only, the recording folder, and
// matching demo data with --seed.
// Usage: node test/compare.mjs [--engine webkit|chromium]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const walkJs = join(root, "skills", "rudi-sim", "scripts", "walk.mjs");
const engine = process.argv.includes("--engine") ? process.argv[process.argv.indexOf("--engine") + 1] : "webkit";
const tmp = mkdtempSync(join(tmpdir(), "rudi-compare-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0, skipped = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) { failures++; if (detail) console.log(detail.split("\n").map((l) => "      " + l).join("\n")); }
};
const children = [];
process.on("exit", () => { for (const c of children) c.kill(); rmSync(tmp, { recursive: true, force: true }); });
function server(port, extra = []) {
  const c = spawn(process.execPath, [join(root, "test", "server.mjs"), String(port), ...extra], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(c);
  return new Promise((ok) => c.stdout.once("data", () => ok(c)));
}
const walk = (...a) => { const r = spawnSync(process.execPath, [walkJs, "do", ...a], { encoding: "utf8", timeout: 120000 }); return { code: r.status, text: (r.stdout || "") + (r.stderr || "") }; };
const step = (label, args, { code = 0, has = [], lacks = [] } = {}) => {
  const r = walk(...args);
  check(r.code === code && has.every((h) => r.text.includes(h)) && lacks.every((h) => !r.text.includes(h)), label, `exit ${r.code}\n${r.text.trim()}`);
  return r;
};
async function open(url, compare, out, extra = []) {
  const c = spawn(process.execPath, [walkJs, "start", url, "--compare", compare, "--device", "iPhone SE", "--headless", "--engine", engine, "--slow", "50", "--out", join(tmp, out), ...extra], { stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; c.stdout.on("data", (d) => (log += d)); c.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 240 && !log.includes("READY"); i++) { if (c.exitCode !== null) break; await sleep(250); }
  if (!log.includes("READY")) { check(false, `window opens for ${url} beside ${compare}`, log); return null; }
  return { c, log: () => log };
}
async function close(w) {
  const r = walk("stop");
  for (let i = 0; i < 60 && w.c.exitCode === null; i++) await sleep(250);
  return r;
}

// A local certificate made for this run only; nothing is stored in the repository.
let tls = null;
const ssl = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(tmp, "key.pem"), "-out", join(tmp, "cert.pem"), "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { encoding: "utf8" });
if (ssl.status === 0) tls = ["--tls", join(tmp, "key.pem"), join(tmp, "cert.pem")];
else { skipped++; console.log("SKIP  https checks (openssl isn't installed here, so no test certificate could be made)"); }

const HTTPS = 5401, HTTP = 5402, LATE = 5409;
await server(HTTP);
if (tls) await server(HTTPS, tls);
// A network address that isn't loopback: browsers treat http on it as insecure, so it
// always exercises mixed-content rules (some engines let http://localhost through).
const lan = Object.values(networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal)?.address;

console.log(`\n== https Before beside http After, and the other way round (${engine}) ==`);
if (tls) {
  const afters = [`http://localhost:${HTTP}`, ...(lan ? [`http://${lan}:${HTTP}`] : [])];
  for (const after of afters) {
    const w = await open(`https://localhost:${HTTPS}/variant`, after, `mixed-${afters.indexOf(after)}`, ["--ignore-https-errors"]);
    if (!w) continue;
    step(`https Before + ${after} After: both screens load`, ["look"], { has: ["Screens ready: 2 of 2", `After: ${after}/variant`, `Page: Variant — https://localhost:${HTTPS}/variant`] });
    // The Before-only button proves Before really is the https site and After the http one.
    step("the labels follow the sites, not the address scheme", ["click", `Port ${HTTPS}`], { has: ["PARTIAL", "(After): not found on this screen"] });
    step("a step on both sides", ["click", "Shared"], { has: ["OK: click Shared"], lacks: ["Not found on"] });
    if (after === afters[0]) {
      step("compare off from an https window", ["compare", "off"], { has: ["compare off", "Screens ready: 1 of 1"] });
      step("compare on again with an http site moves the window to a page that can show both", ["compare", after], { has: ["Screens ready: 2 of 2", `After: ${after}/variant`] });
    }
    await close(w);
  }
  const w = await open(`http://localhost:${HTTP}/variant`, `https://localhost:${HTTPS}`, "mixed-reversed", ["--ignore-https-errors"]);
  if (w) {
    step("http Before + https After: both screens load", ["look"], { has: ["Screens ready: 2 of 2", `After: https://localhost:${HTTPS}/variant`] });
    step("labels in the reversed order", ["click", `Port ${HTTP}`], { has: ["PARTIAL", "(After): not found on this screen"] });
    await close(w);
  }
}

console.log(`\n== One site isn't running (${engine}) ==`);
{
  const w = await open(`http://localhost:${HTTP}/variant`, `http://localhost:${LATE}`, "down", ["--pane-timeout", "5000"]);
  if (w) {
    check(/WARNING: 1 of 2 screens didn't load/.test(w.log()), "start warns which screen didn't load", w.log());
    step("look fails and names the screen and the reason", ["look"], { code: 1, has: ["Screens ready: 1 of 2", "(After): error", "connection refused", `http://localhost:${LATE}/variant`] });
    step("the working side still works", ["click", "Shared"], { code: 1, has: ["Shared"] });
    await server(LATE);
    step("retry loads only the failed screen", ["retry"], { has: ["retry (1 screen;", "Screens ready: 2 of 2"] });
    step("and then everything works", ["click", "Shared"], { lacks: ["Not found on"] });
    console.log(`\n== A page slower than the time allowed (${engine}) ==`);
    step("a page that takes longer than --pane-timeout is reported as still loading", ["goto", "/slow"], { code: 1, has: ["hadn't arrived", "still be loading"] });
    await sleep(3000);
    step("once it arrives, look says every screen is ready", ["look"], { has: ["Screens ready: 2 of 2", "Slow"] });
    const r = await close(w);
    const folder = r.text.match(/^Recording folder: (.+)$/m)?.[1];
    check(!!folder && existsSync(join(folder, "session.json")), "stop names the recording folder, which explains itself", r.text);
    if (folder && existsSync(join(folder, "session.json"))) {
      const m = JSON.parse(readFileSync(join(folder, "session.json"), "utf8"));
      const v = m.videos?.[0];
      check(v?.finalized && v.bytes > 0 && statSync(v.path).size === v.bytes, "the video is finished and its size recorded before stop answers", JSON.stringify(m, null, 2));
    }
  }
}

console.log(`\n== Matching demo data with --seed (${engine}) ==`);
for (const seeded of [false, true]) {
  const w = await open(`http://localhost:${HTTP}/random`, `http://localhost:${LATE}`, `seed-${seeded}`, seeded ? ["--seed", "7"] : []);
  if (!w) continue;
  const value = walk("look").text.match(/Value [\d.]+/)?.[0];
  const r = walk("click", value || "Value");
  check(seeded ? !r.text.includes("Not found on") : r.text.includes("Not found on"),
    seeded ? "with --seed both sides make the same demo data" : "without it, demo data made in the browser differs between sides", r.text);
  await close(w);
}

console.log(`\n${failures ? `${failures} check(s) failed` : "All checks passed"}${skipped ? ` (${skipped} group skipped)` : ""}.`);
process.exit(failures ? 1 : 0);
