#!/usr/bin/env node
// Screenshot mode: full-page screenshots of one URL on several Apple devices.
//
// Usage: node check.mjs <url> [--device "iPad mini"] [--themes light,dark]
//        [--landscape] [--viewport-only] [--out <folder>] [--wait <ms>]
//        node check.mjs --list
import { join } from "node:path";
import { contextOptions, launchOptions, listDevices, loadPlaywright, makeOutDir, normalizeUrl, parseArgs, pick } from "./lib.mjs";

const { flags, positional } = parseArgs(process.argv.slice(2), ["list", "landscape", "viewport-only", "help", "dry-run"]);
if (flags.list || flags.help) { listDevices(); process.exit(0); }
if (!positional[0]) {
  console.error('Usage: node check.mjs <url> [--device "iPad mini"] [--themes light,dark] [--landscape] [--viewport-only]\n       node check.mjs --list');
  process.exit(2);
}
let chosen;
try { chosen = pick(flags.device ?? flags.devices ?? "default"); }
catch (e) { console.error(e.message); process.exit(2); }
if (flags["dry-run"]) { console.log(chosen.map((d) => d.name).join("\n")); process.exit(0); }

const target = normalizeUrl(positional[0]);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const themes = String(flags.themes || "light,dark").split(",").map((s) => s.trim().toLowerCase()).filter((t) => t === "light" || t === "dark");
if (!themes.length) { console.error('--themes must be light, dark or "light,dark"'); process.exit(2); }
// Very long pages make huge images nobody can read; cut them off here.
const MAX_HEIGHT = Number(flags["max-height"] || 6000);
const engine = flags.engine || "webkit";
const playwright = loadPlaywright();

let outDir;
try { const o = makeOutDir(flags.out, `check-${stamp}`); outDir = o.dir; if (o.note) console.log(o.note); }
catch (e) { console.error(e.message); process.exit(2); }
const browser = await playwright[engine].launch(launchOptions());

async function shoot(d, theme) {
  const ctx = await browser.newContext(contextOptions(playwright, d, { theme, landscape: flags.landscape, engine }));
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`JS error: ${e.message.split("\n")[0]}`));
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && problems.push(`console: ${m.text().slice(0, 200)}`));
  page.on("response", (r) => {
    let u; try { u = new URL(r.url()); } catch { return; }
    if (r.status() >= 400 && !u.pathname.endsWith("favicon.ico")) problems.push(`${r.status()} for ${u.pathname}${r.request().resourceType() === "document" ? " (the page itself)" : ""}`);
  });
  const file = join(outDir, `${d.key}${flags.landscape && d.type !== "mac" ? "-landscape" : ""}-${theme}.png`);
  try {
    await page.goto(target, { waitUntil: "load", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(Number(flags.wait || 1500));
    const m = await page.evaluate(() => ({
      overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth - 1),
      height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    }));
    if (m.overflow) problems.push(`page is ${m.overflow + 1}px wider than the screen (sideways scrolling)`);
    const vp = page.viewportSize();
    if (flags["viewport-only"]) await page.screenshot({ path: file, timeout: 60000 });
    else {
      const h = Math.min(m.height, MAX_HEIGHT);
      if (m.height > MAX_HEIGHT) problems.push(`page is ${m.height}px tall; screenshot stops at ${MAX_HEIGHT}px`);
      await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, width: vp.width, height: Math.max(h, vp.height) }, timeout: 60000 });
    }
    return { device: d.name, theme, file, problems };
  } catch (e) {
    return { device: d.name, theme, file: null, problems: [...problems, `failed: ${e.message.split("\n")[0]}`] };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// A few devices at a time keeps big runs quick without overloading the computer.
const jobs = chosen.flatMap((d) => themes.map((t) => [d, t]));
const results = new Array(jobs.length);
let next = 0;
await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
  while (next < jobs.length) { const i = next++; results[i] = await shoot(...jobs[i]); }
}));
await browser.close();

console.log(`\nApple screen check of ${target}\nScreenshots in: ${outDir}\n`);
for (const r of results) {
  console.log(`${r.device} (${r.theme}): ${r.file ? "saved " + r.file : "NOT saved"}`);
  for (const p of r.problems.slice(0, 5)) console.log(`   - ${p}`);
}
console.log("\nNote: this is Safari's engine (WebKit) at Apple screen sizes, not a real device. Check anything critical on a real device too.");
