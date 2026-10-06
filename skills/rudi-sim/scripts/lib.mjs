// Shared helpers: the device list, name matching, Playwright loading and the
// browser context for a device.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const { devices: DEVICES, groups: GROUPS } = JSON.parse(readFileSync(join(here, "devices.json"), "utf8"));
const TYPE_LABEL = { iphone: "iPhones", ipad: "iPads", mac: "Macs" };

// --flag value pairs; names in `bools` take no value.
export function parseArgs(argv, bools = []) {
  const BOOL = new Set(bools);
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      flags[name] = BOOL.has(name) ? true : argv[++i];
    } else positional.push(a);
  }
  return { flags, positional };
}

const norm = (s) => String(s).toLowerCase().replace(/^apple\s*/, "").replace(/[^a-z0-9]/g, "");

export function listDevices() {
  console.log("Apple devices you can use (by name or short key):\n");
  for (const type of Object.keys(TYPE_LABEL)) {
    console.log(TYPE_LABEL[type]);
    for (const d of DEVICES.filter((x) => x.type === type)) {
      console.log(`  ${d.key.padEnd(15)} ${d.name.padEnd(36)} ${d.width}×${d.height}`);
    }
    console.log("");
  }
  console.log(`Groups: ${Object.entries(GROUPS).map(([g, ks]) => `${g} (${ks.length})`).join(", ")}`);
  console.log(`Screenshot checks with no --device use "default": ${GROUPS.default.join(", ")}`);
  console.log(`Custom sizes work anywhere a device does: "390x844", "1280x800@1", "800x1280 tablet".`);
}

// Turns "iPad mini", "16 pro max", "ipads" or "se,imac" into device entries.
export function pick(spec) {
  if (spec === undefined || spec === null || spec === true || !String(spec).trim()) throw new Error('No device named. Give one or more, e.g. --device "iPhone 16, iPad mini", or run with --list to see them all.');
  const out = [];
  for (const raw of String(spec).split(",").map((s) => s.trim()).filter(Boolean)) {
    const custom = customDevice(raw);
    if (custom) { out.push(custom); continue; }
    const n = norm(raw).replace(/^iphone(?=\d|se|air|mini)/, "");
    const exact = DEVICES.find((d) => d.key === n || (d.aliases || []).includes(n)) ||
      DEVICES.find((d) => norm(d.name) === norm(raw) || norm(d.name.replace(/\s*\(.*\)/, "")) === norm(raw));
    if (exact) { out.push(exact); continue; }
    const group = GROUPS[n] || GROUPS[n + "s"] || (n === "phones" && GROUPS.iphones);
    if (group) { out.push(...group.map((k) => DEVICES.find((d) => d.key === k))); continue; }
    const partial = DEVICES.filter((d) => norm(d.name).includes(norm(raw)) || d.key.startsWith(n));
    if (partial.length === 1) { out.push(partial[0]); continue; }
    if (partial.length > 1) throw new Error(`"${raw}" matches several devices: ${partial.map((d) => d.name).join(", ")}. Be more specific.`);
    throw new Error(`No device called "${raw}". Run with --list to see them all.`);
  }
  return [...new Set(out)];
}

// "390x844", "1280 x 800 @2" or "800x600 phone": any screen size, in CSS pixels.
// Scale defaults to 2 (3 for phone-sized). Type guesses from width unless named.
export function customDevice(raw) {
  const m = String(raw).trim().toLowerCase().match(/^(?:custom\s*)?(\d{2,5})\s*[x×*]\s*(\d{2,5})(?:\s*@\s*([\d.]+)x?)?(?:\s+(phone|iphone|tablet|ipad|desktop|mac))?$/);
  if (!m) return null;
  const width = Number(m[1]), height = Number(m[2]);
  if (width < 200 || height < 200 || width > 7680 || height > 4320) throw new Error(`Custom size ${width}×${height} is out of range (200 to 7680 wide, 200 to 4320 tall).`);
  const named = { phone: "iphone", iphone: "iphone", tablet: "ipad", ipad: "ipad", desktop: "mac", mac: "mac" }[m[4]];
  const type = named || (width < 600 ? "iphone" : width < 1100 ? "ipad" : "mac");
  const scale = m[3] ? Math.min(4, Math.max(1, Number(m[3]))) : type === "iphone" ? 3 : 2;
  return { key: `custom-${width}x${height}`, name: `Custom ${width}×${height}`, type, width, height, scale, custom: true };
}

export function loadPlaywright() {
  const home = process.env.RUDI_SIM_HOME || join(homedir(), ".rudi-sim");
  try {
    // The desktop app brings its own copy of Playwright and names its folder here.
    if (process.env.RUDI_SIM_PLAYWRIGHT) return createRequire(join(process.env.RUDI_SIM_PLAYWRIGHT, "package.json"))(process.env.RUDI_SIM_PLAYWRIGHT);
    return createRequire(join(home, "package.json"))("playwright");
  } catch {
    console.error(`Playwright isn't set up yet. Run the setup script first:\n  node "${join(here, "setup.mjs")}"`);
    process.exit(3);
  }
}

export function normalizeUrl(url) {
  if (/^[a-z]+:\/\//i.test(url)) return url;
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/i.test(url);
  return `${local ? "http" : "https"}://${url}`;
}

// iPhones send the iPhone Safari user agent. iPads and Macs send the Mac one,
// because iPad Safari asks for desktop sites by default.
// `engine` other than webkit exists only to test these scripts where WebKit can't install.
export function contextOptions(playwright, d, { theme = "light", landscape = false, engine = "webkit" } = {}) {
  const mobile = d.type !== "mac";
  const base = playwright.devices[d.type === "iphone" ? "iPhone 15" : "Desktop Safari"];
  const [w, h] = landscape && mobile ? [d.height, d.width] : [d.width, d.height];
  const opts = {
    userAgent: base.userAgent,
    viewport: { width: w, height: h },
    screen: { width: w, height: h },
    deviceScaleFactor: d.scale,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: theme,
  };
  if (engine !== "webkit") delete opts.isMobile;
  return opts;
}

export function launchOptions(extra = {}) {
  const o = { ...extra };
  if (process.env.RUDI_SIM_EXECUTABLE) o.executablePath = process.env.RUDI_SIM_EXECUTABLE;
  if (process.env.RUDI_SIM_ARGS) o.args = process.env.RUDI_SIM_ARGS.split(" ").filter(Boolean);
  return o;
}

// Makes the folder screenshots and videos go in. With no --out it's
// ./rudi-sim/<name>; if that can't be written (Claude Code started in a
// protected folder such as Program Files), it falls back to the temp folder
// and says so, rather than crashing on the first run.
export function makeOutDir(out, name) {
  if (out) {
    const dir = resolve(String(out));
    try { mkdirSync(dir, { recursive: true }); return { dir }; }
    catch (e) { throw new Error(`Can't save to ${dir} (${e.code || e.message}). Pass --out with a folder you can write to.`); }
  }
  const dir = resolve(process.cwd(), "rudi-sim", name);
  try { mkdirSync(dir, { recursive: true }); return { dir }; }
  catch (e) {
    const fallback = join(tmpdir(), "rudi-sim", name);
    mkdirSync(fallback, { recursive: true });
    return { dir: fallback, note: `Couldn't write to ${dir} (${e.code || e.message}), so saving to ${fallback} instead. Pass --out <folder> to choose where.` };
  }
}
