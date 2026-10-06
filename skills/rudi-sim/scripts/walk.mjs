#!/usr/bin/env node
// Watch mode: opens a visible Safari (WebKit) window at an Apple device's size
// and lets Claude drive it one step at a time while you watch. A red dot shows
// where each tap lands and a caption says what is happening. Every step saves a
// screenshot, and the whole session is recorded to a video.
//
// Name several devices (--device "iPhone 16, iPad mini, iMac") to see them side
// by side in one window, each scaled to fit; tick screens on or off in the window.
// Add --compare <second url> to show every screen twice, Before (the first url)
// and After (the same page on the second url), with every step done on both.
//
//   node walk.mjs start <url> [--device "iPhone 16"] [--theme dark] [--landscape]
//                             [--compare <url>] [--port 7777] [--slow 600] [--headless] [--out <folder>]
//                             [--name <project>] [--seed <n>] [--pane-timeout <ms>] [--ignore-https-errors]
//   node walk.mjs do <action> [args...]      (see ACTIONS below)
//   node walk.mjs tour <tour.json> [<url>] [same options as start]
//   node walk.mjs stop
//
// The parts: viewer.mjs (the Screens window and the in-page overlay), panes.mjs
// (which screens loaded), actions.mjs (finding, tapping, scrolling in one screen),
// recording.mjs (folders, video finishing). This file owns the session.
import http from "node:http";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEVICES, contextOptions, customDevice, here, launchOptions, loadPlaywright, makeOutDir, normalizeUrl, parseArgs, pick } from "./lib.mjs";
import { OVERLAY, screensPage } from "./viewer.mjs";
import { afterTarget, errorPage, expectedPanes, explainFetchError, notReady, paneLabel, viewerOrigin, waitForPanes } from "./panes.mjs";
import { find, notFoundMessage, scrollFrame, tappable } from "./actions.mjs";
import { finalizeVideo, projectFromUrl, recordingsRoot, sessionName, writeManifest } from "./recording.mjs";

const ACTIONS = `Actions for "do":
  goto <url>              open a page (a path like /pricing stays on the same site)
  click <text|selector>   tap a button, link or tab by its words, or a CSS selector
  type <field> <text>     type into a field found by its label, placeholder or selector
  press <key>             press a key, e.g. Enter, Escape, Tab
  scroll <down|up|top|bottom|pixels>
  back                    go back a page
  wait <ms>               pause
  say <text>              show a caption in the window (to explain what you're doing)
  look                    screenshot plus a list of what's tappable on screen
  shot [name]             screenshot only
  device <names>          switch device, same page. Several at once ("iPhone 16, iPad mini, iMac")
                          shows them side by side in one window
  menu                    open or close the Screens checklist (Screens window only)
  compare <url|off>       show each screen twice: Before (this site) and After (the same page on <url>)
  retry [names|all]       load again only the screens that didn't load (or the named ones)
  rotate [names]          turn screens 90° (again to turn back); no names turns them all
  actual [name]           show one screen at its actual size (Screens window); no name goes back to all
  theme <light|dark>      switch light or dark mode
  stop                    close the window and save the video`;

const HOME = process.env.RUDI_SIM_HOME || join(homedir(), ".rudi-sim");
const STATE = join(HOME, "walk-session.json");
// Written while a window is starting up, so "do" waits for it instead of giving up.
const STARTING = join(HOME, "walk-starting.json");
// Why the last window closed, so "do" can say so instead of just "not running".
const LAST_EXIT = join(HOME, "walk-last-exit.json");
const [cmd, ...rest] = process.argv.slice(2);


// ---- client side: send one action to the running window ----
async function sendAction(args) {
  if (!args.length) { console.log(ACTIONS); process.exit(2); }
  // Wait while a window is actually starting (plus a moment for a start that was
  // only just run in the background); otherwise say so within a few seconds.
  let state;
  for (let i = 0; i < 240 && !state; i++) {
    try { state = JSON.parse(readFileSync(STATE, "utf8")); break; } catch {}
    if (i >= 6 && !starting()) break;
    await sleep(500);
  }
  if (!state) { console.error(`No simulator window is running.${lastExit()} Start one with: node walk.mjs start <url>`); process.exit(3); }
  const body = JSON.stringify({ action: args[0], args: args.slice(1) });
  const res = await new Promise((ok, fail) => {
    const req = http.request({ host: "127.0.0.1", port: state.port, path: "/do", method: "POST", headers: { "content-type": "application/json" } }, (r) => {
      let data = ""; r.on("data", (c) => (data += c)); r.on("end", () => ok(data));
    });
    req.on("error", fail); req.end(body);
  }).catch(() => null);
  if (res === null) {
    rmSync(STATE, { force: true });
    console.error(`The simulator window isn't running any more.${lastExit() || " It may have been closed."} Start it again with: node walk.mjs start <url>`);
    process.exit(3);
  }
  const r = JSON.parse(res);
  printResult(r);
  process.exit(r.ok ? 0 : 1);
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
function starting() {
  try { const { pid, at } = JSON.parse(readFileSync(STARTING, "utf8")); return alive(pid) && Date.now() - at < 120000; } catch { return false; }
}
function lastExit() {
  try { const { reason, at } = JSON.parse(readFileSync(LAST_EXIT, "utf8")); return ` The last window closed at ${new Date(at).toLocaleTimeString()}: ${reason.replace(/[.\s]*$/, ".")}`; } catch { return ""; }
}

function printResult(r) {
  console.log(!r.ok ? `FAILED: ${r.did}\n  ${r.error}` : r.partial ? `PARTIAL: ${r.did} (done on some screens, not all)` : `OK: ${r.did}`);
  if (r.device) console.log(`Device: ${r.device}`);
  if (r.url) console.log(`Page: ${r.title ? r.title + " — " : ""}${r.url}`);
  if (r.compare) console.log(`After: ${r.compare}`);
  if (r.panes) {
    const ready = r.panes.filter((p) => p.state === "ready").length;
    console.log(`Screens ready: ${ready} of ${r.panes.length}`);
    for (const p of r.panes.filter((x) => x.state !== "ready")) console.log(`  - ${p.screen}: ${p.state}${p.error ? `, ${p.error}` : ""}${p.requested ? ` (${p.requested})` : ""}`);
  }
  if (r.results?.some((x) => !x.ok)) console.log(`Per screen:\n${r.results.map((x) => `  - ${x.screen}: ${x.ok ? "done" : x.error}`).join("\n")}`);
  if (r.screenshot) console.log(`Screenshot: ${r.screenshot}`);
  if (r.video) console.log(`Video: ${r.video}`);
  if (r.recording?.folder) console.log(`Recording folder: ${r.recording.folder}`);
  if (r.problems?.length) console.log(`Problems since last step:\n${r.problems.map((p) => "  - " + p).join("\n")}`);
  if (r.tappable?.length) console.log(`Tappable on screen:\n${r.tappable.map((t) => "  - " + t).join("\n")}`);
}

// Makes Math.random repeat the same numbers on every page and screen, so demo
// data a site makes up in the browser matches between Before and After.
const SEED = (seed) => `(() => { let a = ${Number(seed) >>> 0}; Math.random = function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();`;

// ---- server side: own the browser window ----
async function runSession(mode, argv) {
  const { flags, positional } = parseArgs(argv, ["headless", "landscape", "no-video", "grid", "single", "ignore-https-errors"]);
  let tour = null;
  if (mode === "tour") {
    const file = positional.shift();
    const path = [file, join(here, "tours", file || ""), join(here, "tours", `${file}.json`)].find((p) => p && existsSync(p));
    if (!path) { console.error(`Can't find tour "${file}". Tours in ${join(here, "tours")}.`); process.exit(2); }
    tour = JSON.parse(readFileSync(path, "utf8"));
  }
  const startUrl = positional[0] || tour?.url;
  if (!startUrl) { console.error("Give a page to open, e.g. node walk.mjs start example.com"); process.exit(2); }
  const opts = {
    device: flags.device ?? flags.devices ?? tour?.device ?? "iPhone 16",
    theme: flags.theme || tour?.theme || "light",
    landscape: !!flags.landscape,
    slow: Number(flags.slow ?? tour?.slow ?? 600),
    // Another engine only for testing these scripts where WebKit can't be installed.
    engine: flags.engine || process.env.RUDI_SIM_ENGINE || "webkit",
    compare: flags.compare ? normalizeUrl(String(flags.compare)) : null,
  };
  const paneTimeout = Math.max(1000, Number(flags["pane-timeout"]) || 30000);
  if (flags.compare === true || flags.compare === "") { console.error('Give the second address to compare against, e.g. --compare localhost:5001'); process.exit(2); }
  if (opts.compare && (mode === "tour" || flags.single)) { console.error("--compare works in the Screens window, so it can't be used with --single or a tour."); process.exit(2); }
  for (const [name, u] of [["page", normalizeUrl(startUrl)], ["--compare address", opts.compare]]) {
    if (!u) continue;
    try { const x = new URL(u); if (!/^https?:$/.test(x.protocol)) throw 0; } catch { console.error(`The ${name} "${u}" isn't a web address.`); process.exit(2); }
  }
  if (flags.seed !== undefined && !/^\d{1,10}$/.test(String(flags.seed))) { console.error("--seed takes a whole number, e.g. --seed 42"); process.exit(2); }
  // One window at a time: a second start would orphan the first.
  if (existsSync(STATE)) {
    let alive = false;
    try {
      const { port } = JSON.parse(readFileSync(STATE, "utf8"));
      alive = await new Promise((ok) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/ping", method: "GET", timeout: 1500 }, () => ok(true));
        req.on("error", () => ok(false)); req.on("timeout", () => { req.destroy(); ok(false); }); req.end();
      });
    } catch {}
    if (alive) { console.error("A simulator window is already open. Use it with walk.mjs do ..., or close it first with: node walk.mjs stop"); process.exit(4); }
    rmSync(STATE, { force: true });
  }
  let devices;
  try { devices = pick(opts.device); } catch (e) { console.error(e.message); process.exit(2); }
  // The Screens window (every screen side by side, with the Screens checklist) is
  // the default for start, even with one device, so the user can always add screens.
  // --single opens one exact device window instead; tours keep one device exact.
  const wantsGrid = (n) => n > 1 || !!flags.grid || !!opts.compare || (mode === "start" && !flags.single);
  let grid = wantsGrid(devices.length);

  const playwright = loadPlaywright();
  // A folder name a person can find later: the project (or site) and the time.
  const project = flags.name ? String(flags.name) : projectFromUrl(normalizeUrl(startUrl));
  const name = sessionName(project);
  let outDir;
  try {
    const o = !flags.out && process.env.RUDI_SIM_RECORDINGS ? makeOutDir(join(recordingsRoot(), name)) : makeOutDir(flags.out, name);
    outDir = o.dir; if (o.note) console.log(o.note);
  } catch (e) { console.error(e.message); process.exit(2); }
  const startedAt = new Date().toISOString();
  // The folder says it's still being recorded, and by which process, so a
  // recordings library can tell a live session from one that was interrupted.
  const baseManifest = () => ({ project, url: normalizeUrl(startUrl), compare: opts.compare, devices: devices.map((d) => d.name), landscape: !!opts.landscape, theme: opts.theme, engine: opts.engine, startedAt, pid: process.pid });
  try { writeManifest(outDir, { ...baseManifest(), status: "recording", videos: [] }); } catch {}
  mkdirSync(HOME, { recursive: true });
  writeFileSync(STARTING, JSON.stringify({ pid: process.pid, at: Date.now() }));
  process.on("exit", () => { try { if (JSON.parse(readFileSync(STARTING, "utf8")).pid === process.pid) rmSync(STARTING, { force: true }); } catch {} });
  const launch = async () => {
    const b = await playwright[opts.engine].launch(launchOptions({ headless: !!flags.headless }));
    b.on("disconnected", () => { if (!closing && !swapping) lost(); });
    return b;
  };
  let browser;
  try { browser = await launch(); }
  catch (e) {
    const why = `The browser couldn't start: ${e.message.split("\n")[0]}`;
    try { writeFileSync(LAST_EXIT, JSON.stringify({ reason: why, at: Date.now() })); } catch {}
    console.error(`${why}\nIf Rudi-Sim isn't set up, run: node "${join(here, "setup.mjs")}"`);
    process.exit(3);
  }
  // If the browser itself stops (its process ended or crashed) rather than the
  // user closing the window, open it again on the same page, a few times at most.
  let restarts = 0, recovering = null;

  let ctxOpenedAt = null;
  let ctx, page, step = 0, problems = [], base = normalizeUrl(startUrl), lastPanes = null;
  const videos = [];
  let swapping = false, closing = false, server, popups = 0;
  // Why each screen's own page failed to load, by frame name (see panes.mjs).
  const docErrors = new Map();
  // Requests still running per frame, so a step can wait for a frame to go quiet
  // instead of waiting for the whole window to be idle.
  const inflight = new Map(), net = new EventEmitter(), bus = new EventEmitter();
  // How many pages each frame has committed, so a step can tell a new page from the old one.
  const commits = new WeakMap(), committed = (f) => commits.get(f) || 0;
  // Screens just sent to a new page (see waitForPanes); used up by the next pane check.
  let expecting = new Map();
  const expectNew = (fs) => { for (const f of fs) if (f.name()) expecting.set(f.name(), { frame: f, n: committed(f) }); };
  net.setMaxListeners(0); bus.setMaxListeners(0);

  async function openContext(url, storageState) {
    let co;
    if (grid) {
      const desk = playwright.devices["Desktop Safari"];
      co = { userAgent: desk.userAgent, colorScheme: opts.theme, viewport: flags.headless ? { width: 1600, height: 1000 } : null };
      if (!flags["no-video"]) co.recordVideo = { dir: outDir, size: { width: 1600, height: 1000 } };
    } else {
      co = contextOptions(playwright, devices[0], { theme: opts.theme, landscape: opts.landscape, engine: opts.engine });
      if (!flags["no-video"]) co.recordVideo = { dir: outDir, size: co.viewport };
    }
    // Only for a local server with its own certificate; it covers this window's pages and nothing else.
    if (flags["ignore-https-errors"]) co.ignoreHTTPSErrors = true;
    if (storageState) co.storageState = storageState;
    ctx = await browser.newContext(co);
    ctxOpenedAt = Date.now();
    await ctx.addInitScript(OVERLAY);
    if (flags.seed !== undefined) await ctx.addInitScript(SEED(flags.seed));
    if (grid) {
      // The screens are iframes of the site, so let the site be framed (it may
      // forbid that). The screens page is served from one of the sites' own
      // addresses (see viewerOrigin), which keeps sign-in cookies working.
      await ctx.route("**/*", async (route) => {
        const req = route.request();
        if (req.resourceType() !== "document") return route.fallback();
        const screen = await frameNameOf(req);
        if (screen) docErrors.delete(screen);
        return serveScreen(route, screen);
      });
      const serveScreen = async (route, screen) => {
        let r;
        try { r = await route.fetch(); }
        catch (e) {
          if (!screen) return route.fallback();
          // Show why in that screen, and remember it for the step's answer.
          const why = explainFetchError(e);
          docErrors.set(screen, why);
          return route.fulfill({ status: 502, contentType: "text/html", headers: { "x-rudi-sim-error": "1" }, body: errorPage(route.request().url(), why) });
        }
        // A redirect was followed: send the screen on to the final address so its
        // links and the address bar stay right (cookies from the hop are already saved).
        if (r.url() !== route.request().url()) {
          return route.fulfill({ status: 200, contentType: "text/html", body: `<meta name="rudi-sim-redirect"><script>location.replace(${JSON.stringify(r.url())})</script>` });
        }
        const h = { ...r.headers() };
        delete h["x-frame-options"];
        if (h["content-security-policy"]) h["content-security-policy"] = h["content-security-policy"].replace(/frame-ancestors[^;]*;?/i, "");
        return route.fulfill({ response: r, headers: h });
      };
      await ctx.route((u) => u.pathname === "/__sim/screens", (route) => route.fulfill({ contentType: "text/html", body: screensPage() }));
    }
    page = await ctx.newPage();
    inflight.clear(); expecting = new Map();
    page.on("framenavigated", (f) => commits.set(f, committed(f) + 1));
    const own = new Map();
    const done = (r) => { const f = own.get(r); if (!f) return; own.delete(r); inflight.set(f, Math.max(0, (inflight.get(f) || 1) - 1)); net.emit("change"); };
    page.on("request", (r) => { let f; try { f = r.frame(); } catch { return; } own.set(r, f); inflight.set(f, (inflight.get(f) || 0) + 1); net.emit("change"); });
    page.on("requestfinished", done);
    page.on("requestfailed", (r) => {
      done(r);
      let u; try { u = new URL(r.url()); } catch { return; }
      if (r.resourceType() === "document" || /^(data|blob):/.test(r.url())) return;
      const why = r.failure()?.errorText || "failed";
      if (/abort|cancel/i.test(why)) return; // a page leaving mid-load cancels its requests
      problems.push(`request failed: ${u.host}${u.pathname} (${why})${grid ? ` on ${screenOf(r)}` : ""}`);
    });
    // Links that open a new tab: show that page in this window instead.
    ctx.on("page", async (p) => {
      if (p === page) return;
      popups++;
      try {
        await p.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        const u = p.url();
        await p.close().catch(() => {});
        if (u && u !== "about:blank") { problems.push(`a link tried to open a new tab (${u}); showing it here instead`); await go(u, true).catch(() => {}); }
      } finally { popups--; bus.emit("popups"); }
    });
    page.on("pageerror", (e) => problems.push(`JS error: ${e.message.split("\n")[0]}`));
    page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && problems.push(`console: ${m.text().slice(0, 200)}`));
    page.on("response", (r) => {
      let u; try { u = new URL(r.url()); } catch { return; }
      if (r.headers()["x-rudi-sim-error"]) return; // our own "couldn't load" page; the step reports it per screen
      if (r.status() >= 400 && !u.pathname.endsWith("favicon.ico")) problems.push(`${r.status()} for ${u.pathname}${r.request().resourceType() === "document" ? " (the page itself)" : ""}`);
    });
    const mine = page;
    page.on("close", () => { if (!closing && !swapping && page === mine) setTimeout(() => lost(), 300); });
    page.on("crash", () => { if (!closing && !swapping && page === mine) lost("crashed"); });
    if (url) await go(url);
  }

  // The screen (frame name) a page request is for, or null for the window itself.
  // A frame's first request comes before its name is known, so ask its iframe.
  async function frameNameOf(req) {
    let f; try { f = req.frame(); } catch { return null; }
    if (!f.parentFrame()) return null;
    return f.name() || await f.frameElement().then((h) => h.getAttribute("name")).catch(() => null);
  }
  function screenOf(req) { try { return label(req.frame()); } catch { return "a screen"; } }

  async function lost(how) {
    if (closing || recovering) return;
    if (!how && browser.isConnected()) return shutdown("The window was closed.");
    if (restarts >= 3) return shutdown(`The browser ${how || "stopped"} again (${restarts} restarts already), so the window was closed.`);
    restarts++;
    const url = base;
    recovering = (async () => {
      swapping = true;
      try {
        if (!browser.isConnected()) browser = await launch();
        else await ctx?.close().catch(() => {});
        await openContext(url);
        problems.push(`the browser ${how || "stopped unexpectedly"}, so Rudi-Sim reopened the window on ${url} (sign-ins from before are gone)`);
        console.log(`The browser ${how || "stopped unexpectedly"}; reopened it on ${url}.`);
      } catch (e) {
        swapping = false; recovering = null;
        return shutdown(`The browser ${how || "stopped unexpectedly"} and couldn't be reopened: ${e.message.split("\n")[0]}`);
      }
      swapping = false; recovering = null;
    })();
    await recovering;
  }

  // Git Bash on Windows rewrites a lone "/pricing" into "C:/Program Files/Git/pricing"
  // before it reaches us. Turn it back into the path that was meant.
  function unmangle(url) {
    const m = String(url).match(/^[a-z]:[\\/](?:program files[^\\/]*[\\/])?git[\\/](.*)$/i);
    return m ? "/" + m[1].replace(/\\/g, "/") : url;
  }
  function absolute(url) { url = unmangle(url); return /^\//.test(url) ? new URL(url, base).href : normalizeUrl(url); }

  async function go(url, fromPopup = false) {
    const target = absolute(url);
    if (grid) {
      const host = viewerOrigin(target, opts.compare);
      const onScreens = page.url().includes("/__sim/screens");
      if (!onScreens || new URL(page.url()).origin !== host) {
        const keys = devices.map((d) => d.key);
        await page.goto(`${host}/__sim/screens#${encodeURIComponent(JSON.stringify({ keys, url: target, before: target, landscape: opts.landscape, compare: opts.compare }))}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      } else {
        expectNew(frames());
        await page.evaluate((u) => window.__screens.goAll(u), target);
      }
      base = target;
      await settle(fromPopup);
      return;
    }
    await page.goto(target, { waitUntil: "load", timeout: 45000 });
    await quiet([page.mainFrame()]);
    base = page.url();
  }

  // The frames being driven: every screen in grid mode, else the page itself.
  function frames() {
    if (!grid) return [page.mainFrame()];
    return page.frames().filter((f) => f.parentFrame() === page.mainFrame() && f.name());
  }
  // Resolves when these frames have had no requests running for `idle` ms, or after `max`.
  // Narrower than waiting for the whole window to be network-idle, and usually much shorter.
  function quiet(fs, idle = 300, max = 2500) {
    return new Promise((ok) => {
      const set = new Set(fs);
      let idleTimer = null;
      const end = setTimeout(fin, max);
      function fin() { clearTimeout(end); clearTimeout(idleTimer); net.off("change", check); ok(); }
      function check() { clearTimeout(idleTimer); if (![...set].some((f) => (inflight.get(f) || 0) > 0)) idleTimer = setTimeout(fin, idle); }
      net.on("change", check); check();
    });
  }
  async function popupsDone(max = 30000) {
    const end = Date.now() + max;
    while (popups && Date.now() < end) await new Promise((ok) => { const t = setTimeout(ok, end - Date.now()); bus.once("popups", () => { clearTimeout(t); ok(); }); });
  }
  // Waits until every screen has loaded (or failed), then for its requests to settle.
  // `idle` is how long the screens must stay without requests; a step that didn't
  // start a new page needs only a short check that it didn't start any fetches.
  async function settle(fromPopup = false, idle = 300) {
    // A link that opened a new tab is still being moved into this window.
    if (!fromPopup) await popupsDone();
    if (!grid) { await page.waitForLoadState("load", { timeout: 20000 }).catch(() => {}); await quiet(frames(), idle); return; }
    await checkPanes();
    await quiet(frames(), idle);
  }
  // Which screens loaded. Screens that didn't are marked in the window with the reason.
  async function checkPanes(timeout = paneTimeout) {
    if (!grid) return (lastPanes = null);
    const keys = await page.evaluate(() => window.__screens?.keys()).catch(() => null);
    const shown = keys?.length ? keys.map(byKey).filter(Boolean) : devices;
    const panes = expectedPanes(shown, opts.compare);
    const asked = Object.fromEntries((await page.evaluate(() => window.__screens?.panes() || []).catch(() => [])).map((x) => [x.name, x.requested]));
    const since = expecting; expecting = new Map();
    const st = await waitForPanes(page, panes, { requested: (p) => asked[p.frame] || (p.side === "after" ? afterTarget(base, opts.compare) : base), errors: docErrors, timeout, compare: opts.compare, since, commits: committed });
    await Promise.all(st.map((s, i) => s.state === "ready" ? null : page.evaluate(([n, e]) => window.__screens?.setPane(n, "error", e), [panes[i].frame, s.error]).catch(() => {})));
    lastPanes = st.map((s, i) => ({ screen: paneLabel(s, opts.compare), frame: panes[i].frame, ...s }));
    return lastPanes;
  }
  // A click may start loading a page a moment later. Watch for that, so the step
  // waits for the new page rather than reporting from the old one.
  // Screens that start loading a page are expected to show a new one before they count as loaded.
  function watchNavigation(fs) {
    const set = new Set(fs), before = new Map(fs.map((f) => [f, committed(f)]));
    let seen = false, wake = null;
    const on = (r) => { try { const f = r.frame(); if (r.isNavigationRequest() && set.has(f)) { seen = true; if (f.name()) expecting.set(f.name(), { frame: f, n: before.get(f) }); wake?.(); } } catch {} };
    page.on("request", on);
    return async (ms = 400) => {
      if (!seen) await new Promise((ok) => { const t = setTimeout(ok, ms); wake = () => { clearTimeout(t); ok(); }; });
      page.off("request", on);
      return seen;
    };
  }
  function label(f) {
    if (!grid) return devices[0].name;
    const [k, side] = f.name().split("|");
    const name = byKey(k)?.name || k;
    return opts.compare ? `${name} (${side === "after" ? "After" : "Before"})` : name;
  }

  async function closeContext() {
    const v = page?.video();
    const from = ctxOpenedAt;
    // Playwright finishes writing the video when the context closes.
    await ctx?.close();
    if (v) {
      const r = await finalizeVideo(v, join(outDir, `walkthrough-${videos.length + 1}-${grid ? "screens" : devices[0].key}.webm`));
      if (r) videos.push({ ...r, durationMs: from ? Date.now() - from : null });
    }
  }

  async function caption(text) {
    await page.evaluate((t) => window.__sim?.say(t), text).catch(() => {});
  }

  // Finds the target on every screen, moves the red dot to it on each, then runs
  // `fn` on each. Returns one result per screen, in screen order.
  async function onEach(target, fn) {
    const all = frames(), found = new Map();
    for (const f of all) { const el = await find(f, target); if (el) found.set(f, el); }
    await Promise.all([...found].map(async ([f, el]) => {
      await el.scrollIntoViewIfNeeded().catch(() => {});
      const c = await el.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }).catch(() => null);
      if (c) await f.evaluate(({ x, y }) => window.__sim?.move(x, y), c).catch(() => {});
    }));
    if (found.size) {
      await sleep(opts.slow);
      await Promise.all([...found.keys()].map((f) => f.evaluate(() => window.__sim?.pulse()).catch(() => {})));
    }
    const results = [];
    for (const f of all) {
      const el = found.get(f);
      if (!el) { results.push({ screen: label(f), ok: false, error: "not found on this screen" }); continue; }
      try { await fn(el, f); results.push({ screen: label(f), ok: true }); }
      catch (e) { results.push({ screen: label(f), ok: false, error: e.message.split("\n")[0].slice(0, 200) }); }
    }
    return { found: found.size, missing: results.filter((r) => r.error === "not found on this screen").map((r) => r.screen), results };
  }
  // Runs `fn` on every screen at once and records how each one went.
  async function onAll(fn) {
    return Promise.all(frames().map(async (f) => {
      try { const extra = await fn(f); return { screen: label(f), ok: extra?.ok ?? true, ...(extra?.error ? { error: extra.error } : {}) }; }
      catch (e) { return { screen: label(f), ok: false, error: e.message.split("\n")[0].slice(0, 200) }; }
    }));
  }

  async function snapshot(name) {
    step += 1;
    const file = join(outDir, `${String(step).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.png`);
    const all = [page.mainFrame(), ...frames()];
    await Promise.all(all.map((f) => f.evaluate(() => window.__sim?.hide(true)).catch(() => {})));
    await page.screenshot({ path: file }).catch(() => {});
    await Promise.all(all.map((f) => f.evaluate(() => window.__sim?.hide(false)).catch(() => {})));
    return file;
  }

  async function switchDevices(spec) {
    let next;
    try { next = pick(spec); } catch (e) { return e.message; }
    const wantGrid = wantsGrid(next.length);
    if (grid && wantGrid) {
      devices = next;
      await page.evaluate((keys) => window.__screens.setDevices(keys), next.map((d) => d.key));
      await settle();
      return null;
    }
    // Moving between one screen and several: reopen, keeping the sign-in.
    const url = grid ? (frames()[0]?.url() || base) : page.url();
    const state = await ctx.storageState();
    swapping = true;
    await closeContext(); devices = next; grid = wantGrid; await openContext(url, state);
    swapping = false;
    return null;
  }

  // The Before page currently shown (for re-serving the window from another address).
  function beforeUrl() { return frames().find((f) => !f.name().endsWith("|after"))?.url() || base; }

  async function act(action, args) {
    if (recovering) await recovering;
    const a = String(action || "").toLowerCase();
    const arg = args.join(" ");
    let did = `${a} ${arg}`.trim(), extra = {}, note = null, results = null;
    if (grid) {
      // Pick up screens the user ticked or unticked in the window.
      const keys = await page.evaluate(() => window.__screens?.keys()).catch(() => null);
      if (keys?.length) devices = keys.map(byKey).filter(Boolean);
    }
    const fail = async (error, more = {}) => ({ ok: false, did, error, ...more, ...(await where()) });
    switch (a) {
      case "goto": case "open":
        await caption(`Opening ${arg}`); await go(arg); break;
      case "click": case "tap": {
        await caption(`Tapping “${arg}”`);
        const navigated = watchNavigation(frames());
        const r = await onEach(arg, async (el) => {
          // A link that opens a new tab: wait for that tab so it can be moved into this window.
          const newTab = !grid && await el.evaluate((e) => { const t = e.closest("a")?.target; return !!t && !["_self", "_top", "_parent"].includes(t); }).catch(() => false);
          const opened = newTab ? ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null) : null;
          await el.click({ timeout: 8000 }).catch(() => el.evaluate((e) => e.click()));
          await opened;
        });
        const moved = await navigated(250);
        if (!r.found) return fail(await notFoundMessage(frames()[0], arg), { tappable: await tappable(frames()[0]) });
        if (r.missing.length) note = `Not found on: ${r.missing.join(", ")}`;
        results = r.results;
        await settle(false, moved ? 300 : 100); await sleep(opts.slow);
        break;
      }
      case "type": {
        const [field, ...words] = args;
        await caption(`Typing in “${field}”`);
        const r = await onEach(field, async (el) => { await el.click(); await el.fill(""); await el.pressSequentially(words.join(" "), { delay: 50 }); });
        if (!r.found) return fail(await notFoundMessage(frames()[0], field), { tappable: await tappable(frames()[0]) });
        if (r.missing.length) note = `Not found on: ${r.missing.join(", ")}`;
        results = r.results;
        did = `type "${words.join(" ")}" into ${field}`; break;
      }
      case "press": {
        const navigated = watchNavigation(frames());
        if (grid) results = await onAll((f) => f.locator(":focus").press(arg || "Enter", { timeout: 2000 }));
        else await page.keyboard.press(arg || "Enter");
        const moved = await navigated(250); await settle(false, moved ? 300 : 100); await sleep(opts.slow); break;
      }
      case "scroll": {
        if (!/^(down|up|top|bottom|-?\d+)$/i.test(arg || "down")) return fail(`Scroll takes down, up, top, bottom or a number of pixels, not "${arg}".`);
        // Each screen scrolls until it stops moving; one that can't move is fine at the end of its page.
        results = await onAll(async (f) => {
          const s = await scrollFrame(f, (arg || "down").toLowerCase());
          return s.to !== s.from || s.atEnd ? { ok: true } : { ok: false, error: `didn't move (still at ${s.to}px)` };
        });
        if (!grid) { const bad = results.find((x) => !x.ok); results = null; if (bad) note = `The page ${bad.error}.`; }
        break;
      }
      case "back": {
        const navigated = grid ? watchNavigation(frames()) : null;
        if (grid) results = await onAll((f) => f.evaluate(() => history.back()));
        else {
          await page.goBack({ waitUntil: "load" }).catch(() => {});
          // Don't back out of the site onto the browser's blank start page.
          if (page.url() === "about:blank") await page.goForward({ waitUntil: "load" }).catch(() => {});
        }
        // history.back() starts loading a moment later.
        if (grid) await navigated(500);
        await settle(); await sleep(opts.slow); break;
      }
      case "wait": await sleep(Number(arg) || 1000); break;
      case "say": await caption(arg); await sleep(Math.min(4000, 800 + arg.length * 40)); break;
      case "look": extra.tappable = await tappable(frames()[0]); break;
      case "shot": break;
      case "device": case "devices": case "screens": {
        const err = await switchDevices(arg);
        if (err) return fail(err);
        break;
      }
      case "compare": {
        if (!grid) return fail("Compare works in the Screens window. Start without --single to use it.");
        if (!arg) return fail("Give the address to compare against, e.g. compare localhost:5001, or compare off.");
        const next = /^(off|none|stop)$/i.test(arg) ? null : normalizeUrl(unmangle(arg));
        if (next) { try { if (!/^https?:$/.test(new URL(next).protocol)) throw 0; } catch { return fail(`"${arg}" isn't an address (${next}).`); } }
        const current = beforeUrl();
        opts.compare = next;
        // An https Before beside an http After needs the window served from the After address.
        if (new URL(page.url()).origin !== viewerOrigin(current, opts.compare)) await go(current);
        else { await page.evaluate((c) => window.__screens.setCompare(c), opts.compare); await settle(); }
        did = opts.compare ? `compare: After shows ${new URL(opts.compare).origin}` : "compare off";
        break;
      }
      case "retry": case "reload": {
        if (!grid) { await page.reload({ waitUntil: "load" }).catch(() => {}); await settle(); did = "retry (reloaded the page)"; break; }
        const st = lastPanes || await checkPanes(2000);
        let names;
        if (arg && !/^all$/i.test(arg)) {
          let ks; try { ks = pick(arg).map((d) => d.key); } catch (e) { return fail(e.message); }
          names = st.filter((s) => ks.includes(s.frame.split("|")[0])).map((s) => s.frame);
        } else names = st.filter((s) => /^all$/i.test(arg) || s.state !== "ready").map((s) => s.frame);
        if (!names.length) { did = "retry (every screen was already loaded)"; break; }
        for (const n of names) docErrors.delete(n);
        expectNew(frames().filter((f) => names.includes(f.name())));
        const reloaded = await page.evaluate((n) => window.__screens.reload(n), names);
        did = `retry (${reloaded.length} screen${reloaded.length === 1 ? "" : "s"}; the others were left as they were)`;
        await settle();
        break;
      }
      case "rotate": case "turn": { // turn one or more screens 90° in the Screens window
        if (!grid) return fail("Rotate works in the Screens window. For a single-device window, start it with --landscape.");
        let ks;
        try { ks = pick(arg || devices.map((d) => d.key).join(",")).map((d) => d.key); } catch (e) { return fail(e.message); }
        const shown = await page.evaluate(() => window.__screens.keys());
        const on = ks.filter((k) => shown.includes(k));
        if (!on.length) return fail(`None of those screens are open. Open: ${shown.join(", ")}`);
        const turned = await page.evaluate((k) => window.__screens.rotate(k), on);
        did = turned.length ? `rotate (turned: ${turned.map((k) => byKey(k)?.name || k).join(", ")})` : "rotate (all screens upright)";
        await sleep(opts.slow); break;
      }
      case "actual": case "actual-size": case "1:1": { // one screen at its actual size, or back to all
        if (!grid) return fail("The single-device window is already at actual size. This is for the Screens window.");
        let k = null;
        if (arg && !/^(off|all|none|back)$/i.test(arg)) {
          let d;
          try { [d] = pick(arg); } catch (e) { return fail(e.message); }
          const shown = await page.evaluate(() => window.__screens.keys());
          if (!shown.includes(d.key)) return fail(`${d.name} isn't open. Open: ${shown.map((x) => byKey(x)?.name || x).join(", ")}`);
          k = d.key;
        }
        const now = await page.evaluate((x) => window.__screens.actual(x), k);
        did = now ? `actual size: ${byKey(now)?.name || now}` : "actual size off (all screens shown)";
        await sleep(400); break;
      }
      case "__restart-browser": // test hook: behaves as if the browser process ended
        await browser.close(); await sleep(500); if (recovering) await recovering; break;
      case "menu": // open or close the Screens checklist in a side-by-side window
        if (!grid) return fail("The Screens checklist isn't in a single-device window (--single or a tour).");
        await page.evaluate(() => document.getElementById("pick").click()); await sleep(400); break;
      case "theme": opts.theme = arg === "dark" ? "dark" : "light"; await page.emulateMedia({ colorScheme: opts.theme }); await sleep(400); break;
      case "stop": case "quit": case "close": {
        const shot = await snapshot("final");
        const recording = await shutdown(null);
        return { ok: !!recording?.finalized || flags["no-video"] === true, did: "stop", screenshot: shot, video: videos.map((v) => v.path).filter(Boolean).join(", ") || null, recording, ...(recording && !recording.finalized && !flags["no-video"] ? { error: recording.error || "The video wasn't saved." } : {}) };
      }
      default: return { ok: false, did, error: `Unknown action "${a}".\n${ACTIONS}` };
    }
    // Every answer from the Screens window says which screens are actually showing a page.
    const panes = grid ? (["goto", "open", "click", "tap", "press", "back", "device", "devices", "screens", "compare", "retry", "reload"].includes(a) && lastPanes ? lastPanes : await checkPanes(3000)) : null;
    const shot = await snapshot(a === "shot" && arg ? arg : `${a}-${arg}`);
    const counts = new Map();
    for (const x of problems) counts.set(x, (counts.get(x) || 0) + 1);
    const p = [...counts].map(([x, n]) => (n > 1 && grid ? `${x} (×${n})` : x)); problems = [];
    if (note) p.unshift(note);
    const out = { ok: true, did, screenshot: shot, problems: p, ...extra, ...(await where()) };
    if (panes) out.panes = panes.map(({ frame, ...s }) => s);
    if (results) { out.results = results; out.partial = results.some((x) => !x.ok) && results.some((x) => x.ok); }
    const missing = panes && notReady(panes, opts.compare);
    if (missing) { out.ok = false; out.error = missing; }
    return out;
  }

  async function where() {
    // In the Screens window, the screens are whatever the checklist says, even while a frame is still loading.
    const keys = grid ? await page.evaluate(() => window.__screens?.keys()).catch(() => null) : null;
    const names = grid ? (keys?.length ? keys.map((k) => byKey(k)?.name || k) : devices.map((d) => d.name)).join(", ") || "no screens" : devices[0].name;
    const all = frames(), f = all.find((x) => !x.name().endsWith("|after")) || all[0];
    const url = f ? await f.evaluate(() => location.href).catch(() => f.url()) : page.url();
    const b = opts.compare && all.find((x) => x.name().endsWith("|after"));
    const compare = b ? await b.evaluate(() => location.href).catch(() => b.url()) : null;
    return { device: `${names}${opts.landscape ? " (landscape)" : ""}, ${opts.theme}`, url, compare, title: await (f || page).title().catch(() => "") };
  }

  let recording = null;
  async function shutdown(reason) {
    if (closing) return recording; closing = true;
    if (reason) console.log(reason);
    try { writeFileSync(LAST_EXIT, JSON.stringify({ reason: reason || "stopped with walk.mjs stop", at: Date.now() })); } catch {}
    try { writeManifest(outDir, { ...baseManifest(), status: "finalizing", videos }); } catch {}
    await closeContext().catch(() => {});
    await browser.close().catch(() => {});
    rmSync(STATE, { force: true });
    server?.close();
    // The folder explains itself and stays after the window is gone.
    const v = videos.find((x) => x.finalized) || videos[0] || null;
    const m = writeManifest(outDir, { ...baseManifest(), status: videos.length && videos.every((x) => x.finalized) ? "ready" : flags["no-video"] ? "ready" : "error", stoppedAt: new Date().toISOString(), reason: reason || "stopped", videos });
    recording = { folder: outDir, video: v?.path || null, bytes: v?.bytes || 0, finalized: !!v?.finalized, ...(v?.error ? { error: v.error } : {}), screenshots: m.screenshots, manifest: join(outDir, "session.json") };
    console.log(`Session saved in ${outDir}${videos.length ? `\nVideo: ${videos.map((x) => x.path).filter(Boolean).join(", ")}` : ""}`);
    setTimeout(() => process.exit(0), 200);
    return recording;
  }

  await openContext(startUrl);

  if (tour) {
    for (const s of tour.steps) {
      if (s.say) { await caption(s.say); await sleep(Math.min(3500, 700 + s.say.length * 35)); }
      if (!s.do) continue;
      const r = await act(s.do, [].concat(s.args ?? s.target ?? s.text ?? []).map(String));
      printResult(r);
      if (!r.ok && !s.optional) console.log("  (carrying on with the tour)");
    }
    await act("stop", []);
    return;
  }

  let queue = Promise.resolve();
  server = http.createServer((req, res) => {
    if (req.url === "/ping") { res.writeHead(200).end("ok"); return; }
    if (req.method !== "POST" || req.url !== "/do") { res.writeHead(404).end(); return; }
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      queue = queue.then(async () => {
        let out;
        try { const { action, args } = JSON.parse(body); out = await act(action, args || []); }
        catch (e) { out = { ok: false, did: "?", error: e.message.split("\n")[0] }; }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      });
    });
  });
  server.listen(Number(flags.port || 0), "127.0.0.1", () => {
    mkdirSync(join(STATE, ".."), { recursive: true });
    writeFileSync(STATE, JSON.stringify({ port: server.address().port, pid: process.pid, outDir }));
    rmSync(STARTING, { force: true });
    const names = devices.map((d) => d.name).join(", ");
    const missing = lastPanes && notReady(lastPanes, opts.compare);
    console.log(`READY: window open showing ${names} on ${base}${opts.compare ? `, next to the same pages on ${opts.compare}` : ""}\nSend steps with: node "${join(here, "walk.mjs")}" do <action> ...\nSaving to ${outDir}${missing ? `\nWARNING: ${missing}` : ""}`);
  });
  process.on("SIGINT", () => shutdown("Stopped."));
  process.on("SIGTERM", () => shutdown("Stopped."));
}

const DEVICES_BY_KEY = Object.fromEntries(DEVICES.map((d) => [d.key, d]));
const byKey = (k) => DEVICES_BY_KEY[k] || (String(k).startsWith("custom-") ? customDevice(k.slice(7)) : null);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

if (cmd === "do" || cmd === "stop") await sendAction(cmd === "stop" ? ["stop"] : rest);
else if (cmd === "start" || cmd === "tour") await runSession(cmd, rest);
else { console.log(`Usage:\n  node walk.mjs start <url> [--device "iPhone 16"] [--theme dark]\n  node walk.mjs do <action> [args]\n  node walk.mjs tour <tour.json> [<url>]\n  node walk.mjs stop\n\n${ACTIONS}`); process.exit(cmd ? 2 : 0); }
