#!/usr/bin/env node
// End-to-end test of Rudi-Sim against the local test site.
// Usage: node test/run.mjs [--engine webkit|chromium] [--skip-tour]
// Exits non-zero if any check fails. Screenshots and videos land in test/out.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = join(root, "skills", "rudi-sim", "scripts");
const out = join(root, "test", "out");
const engine = process.argv.includes("--engine") ? process.argv[process.argv.indexOf("--engine") + 1] : "webkit";
const PORT = 5077;
const site = `localhost:${PORT}`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// The site runs in its own process: spawnSync below blocks this one.
const server = spawn(process.execPath, [join(root, "test", "server.mjs"), String(PORT)], { stdio: "ignore" });
process.on("exit", () => server.kill());
await new Promise((r) => setTimeout(r, 1000));

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) { failures++; if (detail) console.log(detail.split("\n").map((l) => "      " + l).join("\n")); }
};
const node = (args, timeout = 180000) => spawnSync(process.execPath, args, { encoding: "utf8", timeout });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const walk = (...a) => {
  const r = node([join(scripts, "walk.mjs"), "do", ...a]);
  return { code: r.status, text: (r.stdout || "") + (r.stderr || "") };
};
const step = (label, args, { ok = true, has = [], lacks = [] } = {}) => {
  const r = walk(...args);
  const good = (ok ? r.code === 0 : r.code === 1) && has.every((h) => r.text.includes(h)) && lacks.every((h) => !r.text.includes(h));
  check(good, label, `exit ${r.code}\n${r.text.trim()}`);
  return r;
};

// ---- check mode ----
console.log(`\n== Check mode (${engine}) ==`);
const all = node([join(scripts, "check.mjs"), site, "--device", "all", "--engine", engine, "--out", join(out, "check-all")], 900000);
const saved = (all.stdout.match(/: saved /g) || []).length;
check(all.status === 0 && saved === 78, `all 39 devices x light/dark saved (${saved}/78)`, all.stdout + all.stderr);
check(!all.stdout.includes("NOT saved"), "no screenshot failed", all.stdout);
const wide = node([join(scripts, "check.mjs"), `${site}/wide`, "--device", "iPhone SE", "--themes", "light", "--engine", engine, "--out", join(out, "check-wide")]);
check(/wider than the screen/.test(wide.stdout), "reports sideways scrolling on a wide page", wide.stdout + wide.stderr);
const errs = node([join(scripts, "check.mjs"), `${site}/errors`, "--device", "iPad mini", "--themes", "dark", "--engine", engine, "--out", join(out, "check-errors")]);
check(/undefinedFn/.test(errs.stdout), "reports JavaScript errors", errs.stdout + errs.stderr);
const missing = node([join(scripts, "check.mjs"), `${site}/missing`, "--device", "imac", "--themes", "light", "--engine", engine, "--out", join(out, "check-404")]);
check(/404 for \/missing \(the page itself\)/.test(missing.stdout), "reports a missing page", missing.stdout + missing.stderr);
const custom = node([join(scripts, "check.mjs"), site, "--device", "390x844, 1280x800@1", "--themes", "light", "--engine", engine, "--out", join(out, "check-custom")]);
check(custom.status === 0 && (custom.stdout.match(/: saved /g) || []).length === 2, "custom screen sizes", custom.stdout + custom.stderr);
const bad = node([join(scripts, "check.mjs"), site, "--device", "iPhone 99"]);
check(bad.status === 2, "unknown device is refused", bad.stdout + bad.stderr);
const empty = node([join(scripts, "check.mjs"), site, "--device", ""]);
check(empty.status === 2 && /No device named/.test(empty.stderr), "an empty --device is refused, not swapped for the defaults", empty.stdout + empty.stderr);
// A folder where ./rudi-sim can't be made (here a file is in the way, which fails
// on every OS, like a read-only or protected folder does): fall back, don't crash.
const stuck = join(out, "unwritable");
mkdirSync(stuck, { recursive: true }); writeFileSync(join(stuck, "rudi-sim"), "a file in the way");
const fb = spawnSync(process.execPath, [join(scripts, "check.mjs"), site, "--device", "iPhone SE", "--themes", "light", "--engine", engine], { cwd: stuck, encoding: "utf8", timeout: 180000 });
check(fb.status === 0 && /saving to .* instead/.test(fb.stdout) && /: saved /.test(fb.stdout), "an unwritable folder falls back to the temp folder instead of crashing", fb.stdout + fb.stderr);
const fbOut = node([join(scripts, "check.mjs"), site, "--device", "iPhone SE", "--out", join(stuck, "rudi-sim", "x")]);
check(fbOut.status === 2 && /Pass --out with a folder you can write to/.test(fbOut.stderr), "an unwritable --out folder gets a plain error", fbOut.stdout + fbOut.stderr);

// ---- watch mode ----
async function startWindow(device, dir, extra = []) {
  const child = spawn(process.execPath, [join(scripts, "walk.mjs"), "start", site, "--device", device, "--headless", "--engine", engine, "--slow", "100", "--out", join(out, dir), ...extra], { stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (child.exitCode !== null) break;
    if (walk("look").code === 0) return { child, log: () => log };
  }
  check(false, `window starts on ${device}`, log);
  return null;
}
async function stopWindow(w, dir) {
  const r = walk("stop");
  check(r.code === 0, "stop closes the window", r.text);
  for (let i = 0; i < 60 && w.child.exitCode === null; i++) await sleep(500);
  const files = existsSync(join(out, dir)) ? readdirSync(join(out, dir)) : [];
  check(files.some((f) => f.endsWith(".webm")), "a video was saved", files.join(", "));
  check(files.some((f) => f.endsWith(".png")), "screenshots were saved", files.join(", "));
  check(walk("look").code === 3, "steps after stop say no window is running");
}

console.log(`\n== Watch mode, no window (${engine}) ==`);
{
  const t = Date.now(), r = walk("look"), secs = (Date.now() - t) / 1000;
  check(r.code === 3 && secs < 5, `a step with no window open says so straight away (${secs.toFixed(1)}s)`, r.text);
}

console.log(`\n== Watch mode, one device (${engine}) ==`);
let w = await startWindow("iPhone 16", "walk-single", ["--single"]);
if (w) {
  const second = node([join(scripts, "walk.mjs"), "start", site, "--headless", "--engine", engine]);
  check(second.status === 4, "a second start is refused while one is open", second.stdout + second.stderr);
  step("look lists the phone menu", ["look"], { has: ["Open menu"] });
  step("tap a button with unicode text", ["click", "Café ☕ “quotes”"]);
  step("the tap really happened", ["look"], { has: ["Clicked!"] });
  step("a link hidden in the phone menu is reported, not faked", ["click", "Wide page"], { ok: false });
  step("open the menu", ["click", "Open menu"]);
  step("follow a menu link", ["click", "Sign up"], { has: ["/form"] });
  step("type by label", ["type", "Email", "a@b.co"]);
  step("type by placeholder with quotes and accents", ["type", "Your name", "Zoë O'Brien & \"friends\""]);
  step("submit the form", ["click", "Create account"], { has: ["/thanks"] });
  step("JS errors are reported", ["goto", "/errors"], { has: ["undefinedFn"] });
  step("a 404 is reported", ["goto", "/missing"], { has: ["404"] });
  step("redirects are followed", ["goto", "/redirect"], { has: ["/thanks"] });
  step("back goes to the previous page", ["back"]);
  step("a slow page finishes loading", ["goto", "/slow"], { has: ["Slow"] });
  step("home", ["goto", "/"]);
  step("open the menu again", ["click", "Open menu"]);
  step("a new-tab link opens in the window", ["click", "New tab"], { has: ["New tab page"] });
  step("sign in sets a cookie", ["goto", "/login"]);
  step("tap sign in", ["click", "Log me in"]);
  step("signed in", ["look"], { has: ["Signed in: yes"] });
  step("a very long page", ["goto", "/long"]);
  step("scroll to the bottom", ["scroll", "bottom"]);
  step("tap the bottom link", ["click", "Bottom home"]);
  step("another site", ["goto", `http://127.0.0.1:${PORT}/other`], { has: ["Other origin"] });
  step("back to the first site", ["goto", `http://localhost:${PORT}/`]);
  step("missing button is reported", ["click", "Nope not here"], { ok: false });
  step("unknown action is reported", ["frobnicate"], { ok: false });
  step("caption", ["say", "Testing captions"]);
  step("switch to iPad mini keeps you signed in", ["device", "iPad mini"]);
  step("still signed in on the iPad", ["look"], { has: ["Signed in: yes"] });
  step("switch to a custom size", ["device", "500x900"], { has: ["500"] });
  step("dark mode", ["theme", "dark"]);
  step("landscape-free key press", ["press", "Tab"]);
  await stopWindow(w, "walk-single");
}

console.log(`\n== Watch mode, one device in the Screens window (${engine}) ==`);
w = await startWindow("iMac", "walk-one");
if (w) {
  step("one screen opens with the Screens checklist", ["menu"]);
  step("close the checklist", ["menu"]);
  step("add screens from one", ["device", "iMac, iPhone 16"]);
  step("both screens show", ["look"], { has: ["Café"] });
  step("turn one screen 90°", ["rotate", "iPhone 16"], { has: ["turned: iPhone 16"] });
  step("still works turned", ["click", "Café ☕ “quotes”"], { lacks: ["Not found on"] });
  step("turn it back", ["rotate", "iPhone 16"], { has: ["all screens upright"] });
  step("rotate a screen that isn't open is reported", ["rotate", "iPad mini"], { ok: false });
  await stopWindow(w, "walk-one");
}

console.log(`\n== Watch mode, side by side (${engine}) ==`);
w = await startWindow("iPhone SE, iPad mini, iMac", "walk-grid");
if (w) {
  step("look shows all screens", ["look"], { has: ["Café"] });
  step("tap on every screen", ["click", "Café ☕ “quotes”"], { lacks: ["Not found on"] });
  step("phone-only menu reports the screens without it", ["click", "Open menu"], { has: ["Not found on"] });
  step("back in step", ["goto", "/login"]);
  step("sign in on every screen (a form post that redirects)", ["click", "Log me in"]);
  step("the next tap waits for the redirect to finish", ["click", "Café ☕ “quotes”"], { lacks: ["Not found on"] });
  step("signed in on every screen", ["look"], { has: ["Signed in: yes"] });
  step("redirects work inside the side-by-side window", ["goto", "/redirect"], { has: ["/thanks"] });
  step("slow page", ["goto", "/slow"], { has: ["Slow"] });
  step("new-tab links stay in their screen", ["goto", "/newtab"], { has: ["New tab page"] });
  step("change the screens", ["device", "iPhone 16, 390x844, MacBook Air 13"]);
  step("open the screens checklist", ["menu"]);
  step("close it", ["menu"]);
  step("back to one device keeps the cookie", ["device", "iPhone 16"]);
  step("the Screens checklist is still there with one screen", ["menu"]);
  step("close it again", ["menu"]);
  step("home", ["goto", "/"]);
  step("still signed in", ["look"], { has: ["Signed in: yes"] });
  step("three screens again", ["device", "iPhone SE, iPad mini, iMac"]);
  step("another site keeps every screen", ["goto", `http://127.0.0.1:${PORT}/other`], { has: ["Other origin", "iPhone SE (2nd & 3rd gen), iPad mini (6th gen & A17 Pro), iMac"] });
  step("and back", ["goto", `http://localhost:${PORT}/`], { has: ["iPhone SE (2nd & 3rd gen), iPad mini (6th gen & A17 Pro), iMac"] });
  step("a path Git Bash rewrote still opens the page", ["goto", "C:/Program Files/Git/login"], { has: [`localhost:${PORT}/login`] });
  step("one screen at actual size", ["actual", "iPad mini"], { has: ["actual size: iPad mini"] });
  step("still taps at actual size", ["click", "Log me in"]);
  step("back to all screens", ["actual"], { has: ["all screens shown"] });
  step("actual size of a screen that isn't open is reported", ["actual", "iPhone 16"], { ok: false, has: ["isn't open"] });
  step("the browser stopping on its own reopens the window and says why", ["__restart-browser"], { has: ["reopened the window", "iPhone SE (2nd & 3rd gen), iPad mini (6th gen & A17 Pro), iMac"] });
  step("the reopened window keeps working", ["goto", "/"]);
  step("taps still reach every screen", ["click", "Café ☕ “quotes”"], { lacks: ["Not found on"] });
  await stopWindow(w, "walk-grid");
}

console.log(`\n== Watch mode, compare Before and After (${engine}) ==`);
// A second copy of the test site on the next port stands in for a branch running beside the current code.
const PORT2 = PORT + 1;
const server2 = spawn(process.execPath, [join(root, "test", "server.mjs"), String(PORT2)], { stdio: "ignore" });
process.on("exit", () => server2.kill());
await sleep(1000);
w = await startWindow("iPhone SE, iPad mini", "walk-compare", ["--compare", `localhost:${PORT2}`]);
if (w) {
  step("look shows Before and After", ["look"], { has: ["Café", `After: http://localhost:${PORT2}/`] });
  step("a tap happens on both sides", ["click", "Café ☕ “quotes”"], { lacks: ["Not found on"] });
  step("a missing button names each side", ["click", "Open menu"], { has: ["iPad mini (6th gen & A17 Pro) (Before)", "iPad mini (6th gen & A17 Pro) (After)"] });
  step("a path opens on both sites", ["goto", "/login"], { has: [`localhost:${PORT}/login`, `After: http://localhost:${PORT2}/login`] });
  step("sign in on both sides", ["click", "Log me in"], { lacks: ["Not found on"] });
  step("signed in on both sides", ["click", "Signed in: yes"], { lacks: ["Not found on"] });
  step("rotate still works in compare", ["rotate", "iPhone SE"], { has: ["turned: iPhone SE"] });
  step("changing screens keeps compare", ["device", "iPhone 16, iMac"], { has: ["After: "] });
  step("taps reach the new pairs", ["click", "Café ☕ “quotes”"], { lacks: ["Not found on"] });
  step("compare off", ["compare", "off"], { has: ["compare off"], lacks: ["After: "] });
  step("compare on again from a running window", ["compare", `localhost:${PORT2}`], { has: [`After: http://localhost:${PORT2}/`] });
  step("compare with no address is refused", ["compare"], { ok: false });
  await stopWindow(w, "walk-compare");
}
server2.kill();
const lone = node([join(scripts, "walk.mjs"), "start", site, "--single", "--compare", `127.0.0.1:${PORT}`, "--headless", "--engine", engine]);
check(lone.status === 2 && /--compare works in the Screens window/.test(lone.stderr), "--compare with --single is refused", lone.stdout + lone.stderr);

console.log(`\n== Screens checklist (${engine}) ==`);
const ui = node([join(root, "test", "screens-page.mjs"), "--engine", engine]);
check(ui.status === 0, "a custom size stays typed when you click away, and Add shows it", ui.stdout + ui.stderr);

if (!process.argv.includes("--skip-tour")) {
  console.log(`\n== Saved tour (${engine}) ==`);
  const tour = node([join(scripts, "walk.mjs"), "tour", "example", site, "--headless", "--engine", engine, "--slow", "100", "--out", join(out, "tour")], 300000);
  check(tour.status === 0, "the example tour plays to the end", (tour.stdout + tour.stderr).slice(-3000));
}

server.kill();
console.log(`\n${failures ? `${failures} check(s) failed` : "All checks passed"}. Output in ${out}`);
process.exit(failures ? 1 : 0);
