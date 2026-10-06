// Rudi-Sim desktop app (Electron). This file is the thin shell: windows, tray,
// sign-in item, dialogs and the bridge to the page. Everything Rudi-Sim actually
// does lives in the shared engine and integrations/desktop/service.mjs, which
// the command-line companion and the tests use too. Websites are always shown
// in Playwright's WebKit, never in Electron's own browser.
import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, powerMonitor, shell } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packaged = app.isPackaged;
// Where the shared engine is: beside the app when installed, the repository when developing.
const engineRoot = packaged ? join(process.resourcesPath, "engine") : resolve(here, "..");
const imp = (rel) => import(pathToFileURL(join(engineRoot, rel)).href);
const playwrightDir = join(app.getAppPath(), "node_modules", "playwright");
// The program assistants run to reach this app (see bin/): it starts the MCP bridge with the app's own runtime.
const launcher = packaged
  ? join(process.resourcesPath, "bin", process.platform === "win32" ? "rudi-sim-mcp.cmd" : "rudi-sim-mcp")
  : join(here, "bin", process.platform === "win32" ? "rudi-sim-mcp-dev.cmd" : "rudi-sim-mcp-dev");
const smoke = process.argv.find((a) => a.startsWith("--smoke-test="))?.slice(13);
const startHidden = process.argv.includes("--hidden");
// "--quit" with no copy running: nothing to do.
if (process.argv.includes("--quit") && app.requestSingleInstanceLock()) { app.releaseSingleInstanceLock(); app.exit(0); process.exit(0); }

// A second copy just brings the first one's window forward (see "second-instance").
if (!app.requestSingleInstanceLock()) {
  if (smoke) console.error("Another copy of Rudi-Sim is already running, so the self-test can't run.");
  // (With --quit the running copy has been told to quit; this one just leaves.)
  app.exit(smoke ? 3 : 0);
  process.exit(smoke ? 3 : 0);
}
// Asked to stop by the system (log out, shutdown, kill): quit cleanly like the Quit button.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => app.quit());
app.setName("Rudi-Sim");
// Windows and Linux get no menu bar; macOS keeps the standard app, edit and window menus.
if (process.platform !== "darwin") Menu.setApplicationMenu(null);
if (process.platform === "win32") app.setAppUserModelId("com.rudiverse.rudisim");

const { Service } = await imp("integrations/desktop/service.mjs");
const { Settings, desktopHome } = await imp("integrations/desktop/settings.mjs");
const { credentialStore } = await imp("integrations/desktop/supervisor.mjs");
const { Runtime } = await imp("integrations/desktop/runtime.mjs");
const { KEY_NAME, validTunnelId } = await imp("integrations/desktop/connection.mjs");
const { acquireLock } = await imp("skills/rudi-sim/scripts/proc.mjs");
const { DEVICES, GROUPS } = await imp("skills/rudi-sim/scripts/lib.mjs");

const home = desktopHome();
mkdirSync(home, { recursive: true });
const settings = new Settings(home);
const credentials = credentialStore();
const nodeEnv = { ELECTRON_RUN_AS_NODE: "1", PLAYWRIGHT_BROWSERS_PATH: join(home, "browsers"), RUDI_SIM_PLAYWRIGHT: playwrightDir };
const runtime = new Runtime({ playwrightDir, browsersDir: join(home, "browsers"), node: process.execPath, nodeEnv });
const testTunnel = process.env.RUDI_SIM_CREDENTIAL_PROVIDER === "env-for-tests" && process.env.RUDI_SIM_TEST_TUNNEL ? { prefix: JSON.parse(process.env.RUDI_SIM_TEST_TUNNEL), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timings: { pollMs: 300, backoffMs: () => 300 } } : {};
let service = null, win = null, tray = null, quitting = false, releaseLock = null;

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
// Claude Code starts the bridge with this app's own runtime (Electron run as
// Node), so nobody needs Node installed. The bridge only forwards to this app.
const bridgeScript = join(engineRoot, "integrations", "local-bridge", "server.mjs");
const claudeArgs = () => ["mcp", "add", "--scope", "user", "--env", "ELECTRON_RUN_AS_NODE=1", "rudi-sim", "--", process.execPath, bridgeScript, "--client", "claude", "--hub-only"];
function claudeCommand() {
  return ["claude", ...claudeArgs()].map((a) => (/[\s"'&|<>^%!()]/.test(a) ? `"${a}"` : a)).join(" ");
}

async function startService() {
  // One Rudi-Sim service per user (shared with the command-line companion).
  releaseLock = acquireLock(join(home, "service.lock"), { role: "app" });
  if (!releaseLock) {
    // Two copies opened at the same moment can both get past the check above
    // (seen on macOS). The service lock is the real referee: the copy that lost
    // to another copy of the app just leaves, quietly, instead of sitting
    // behind an error box that nobody sees when it was opened hidden.
    let holder = null;
    try { holder = JSON.parse(readFileSync(join(home, "service.lock"), "utf8")); } catch {}
    if (holder?.role === "app" || startHidden || smoke) {
      if (holder?.role !== "app") console.error("The Rudi-Sim command-line companion is running; stop it (rudi-sim-desktop quit) first.");
      app.exit(smoke ? 3 : holder?.role === "app" ? 0 : 1);
      return;
    }
    dialog.showErrorBox("Rudi-Sim is already running", "The Rudi-Sim command-line companion is running on this computer. Stop it (rudi-sim-desktop quit), then open the app again.");
    app.exit(1);
    return;
  }
  service = new Service({
    home, settings, credentials, node: process.execPath, nodeEnv, launcher, version: app.getVersion(),
    headless: !!smoke && process.env.RUDI_SIM_SMOKE_HEADLESS === "1",
    trash: (folder) => shell.trashItem(folder),
    engineArgs: process.env.RUDI_SIM_ENGINE ? ["--engine", process.env.RUDI_SIM_ENGINE] : [],
    connectionOptions: testTunnel,
  });
  const push = () => { send("status", fullStatus()); updateTray(); };
  service.connection.on("change", push);
  service.hub.on("change", push);
  await service.start();
  powerMonitor.on("resume", () => service.connection.onResume());
}

function fullStatus() {
  if (!service) return null;
  const s = service.status();
  return { ...s, runtime: runtimeState, claudeCommand: claudeCommand(), launcher, platform: process.platform, keySaved: keySavedCache };
}
let runtimeState = { checking: true };
let keySavedCache = false;
async function refreshKeySaved() {
  const id = settings.get().tunnelId;
  keySavedCache = !!(credentials && validTunnelId(id) && (await credentials.get(KEY_NAME(id)).catch(() => null)));
}

// ---- window and tray ----
function createWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return win; }
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 860, minHeight: 600, show: false, title: "Rudi-Sim",
    backgroundColor: "#0f1115", icon: join(here, "assets", "icon.png"),
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile(join(here, "ui", "index.html"));
  win.once("ready-to-show", () => { if (!startHidden) win.show(); });
  win.on("close", (e) => {
    if (quitting) return;
    if (settings.get().keepRunningInBackground && tray) { e.preventDefault(); win.hide(); }
  });
  return win;
}

const STATE_LABEL = { "needs-setup": "ChatGPT: not set up", disconnected: "ChatGPT: disconnected", starting: "ChatGPT: starting", connecting: "ChatGPT: connecting", connected: "ChatGPT: connected", reconnecting: "ChatGPT: reconnecting", "auth-failed": "ChatGPT: key not accepted", failed: "ChatGPT: stopped retrying", stopping: "ChatGPT: disconnecting" };
function trayIcon() {
  const f = join(here, "assets", process.platform === "darwin" ? "trayTemplate.png" : "tray.png");
  const img = nativeImage.createFromPath(f);
  if (process.platform === "darwin") img.setTemplateImage(true);
  return img;
}
function updateTray() {
  if (!tray || !service) return;
  const c = service.connection.status(), h = service.hub.status(), s = settings.get();
  const chat = s.use.chatgpt;
  tray.setToolTip(`Rudi-Sim${chat ? ` · ${STATE_LABEL[c.state] || c.state}` : ""}${h.simulator.running ? " · simulator open" : ""}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Rudi-Sim", click: () => createWindow() },
    { type: "separator" },
    ...(chat ? [
      { label: STATE_LABEL[c.state] || c.state, enabled: false },
      { label: "Connect", enabled: !["connected", "starting", "connecting", "stopping"].includes(c.state), click: () => service.connection.connect() },
      { label: "Disconnect", enabled: c.state !== "disconnected" && c.state !== "needs-setup", click: () => service.connection.disconnect() },
      { label: "Restart connection", enabled: c.state !== "needs-setup", click: () => service.connection.restart() },
      { type: "separator" },
    ] : []),
    { label: h.simulator.running ? `Simulator open${h.simulator.owner ? ` (${h.simulator.owner})` : ""}` : "Simulator not open", enabled: false },
    { label: "Stop simulator", enabled: h.simulator.running, click: () => service.simulator("rudi_stop", {}, { force: true }) },
    { label: "Open recordings folder", click: () => { mkdirSync(service.library.root, { recursive: true }); shell.openPath(service.library.root); } },
    { type: "separator" },
    { label: "Quit Rudi-Sim", click: () => app.quit() },
  ]));
}

// ---- requests from the page (preload.cjs exposes only `invoke` and `on`) ----
const handlers = {
  status: () => fullStatus(),
  devices: () => ({ devices: DEVICES.map((d) => ({ key: d.key, name: d.name, type: d.type, width: d.width, height: d.height })), groups: GROUPS }),
  saveSettings: (patch) => {
    const allowed = ["use", "startAtLogin", "keepRunningInBackground", "setupDone", "devices", "landscape", "customSizes"];
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
    const next = settings.set(clean);
    if ("startAtLogin" in clean && process.platform !== "linux") app.setLoginItemSettings({ openAtLogin: !!next.startAtLogin, args: ["--hidden"] });
    if ("use" in clean && !next.use.chatgpt && service.connection.child) service.connection.shutdown();
    updateTray();
    return fullStatus();
  },
  chooseFolder: async ({ title }) => { const r = await dialog.showOpenDialog(win, { title: title || "Choose a folder", properties: ["openDirectory", "createDirectory"] }); return r.canceled ? null : r.filePaths[0]; },
  setRecordingsDir: ({ dir, move }) => service.setRecordingsDir(dir, { move: !!move }),
  // ---- engine ----
  runtimeCheck: () => (runtimeState = { checking: false, ...runtime.check() }),
  runtimeInstall: async () => {
    runtimeState = { installing: true, percent: 0 };
    send("runtime", runtimeState);
    const r = await runtime.install({ onProgress: (p) => send("runtime", { installing: true, ...p }) });
    runtimeState = r.ok ? { checking: false, ...runtime.check() } : { ok: false, error: r.error };
    send("runtime", runtimeState);
    return runtimeState;
  },
  // ---- ChatGPT connection ----
  chooseTunnelClient: async () => {
    const r = await dialog.showOpenDialog(win, { title: "Choose OpenAI's tunnel-client", properties: ["openFile"], filters: process.platform === "win32" ? [{ name: "Programs", extensions: ["exe"] }] : [] });
    if (r.canceled) return null;
    settings.set({ tunnelClient: r.filePaths[0] });
    return r.filePaths[0];
  },
  // The key goes straight into the system's secret store; it is never kept, logged or sent back.
  saveTunnel: async ({ tunnelId, key }) => {
    if (!validTunnelId(tunnelId)) throw new Error("A tunnel ID looks like tunnel_ followed by letters and numbers.");
    if (!credentials) throw new Error("This computer has no secure password store, so Rudi-Sim can't keep the key.");
    if (key) await credentials.set(KEY_NAME(tunnelId), String(key).trim());
    else if (!(await credentials.get(KEY_NAME(tunnelId)).catch(() => null))) throw new Error("Paste the tunnel's runtime API key.");
    settings.set({ tunnelId, use: { ...settings.get().use, chatgpt: true } });
    await refreshKeySaved();
    return fullStatus();
  },
  checkTunnel: () => service.connection.check(),
  connect: () => service.connection.connect(),
  disconnect: () => service.connection.disconnect(),
  restartConnection: () => service.connection.restart(),
  forgetConnection: async () => {
    const r = await dialog.showMessageBox(win, { type: "warning", buttons: ["Delete key and tunnel ID", "Cancel"], defaultId: 1, cancelId: 1, message: "Forget the ChatGPT connection?", detail: "This deletes the saved tunnel key from your computer's password store and clears the tunnel ID. Recordings and other settings stay. You can set it up again later." });
    if (r.response !== 0) return { forgotten: false };
    await service.connection.disconnect();
    const id = settings.get().tunnelId;
    if (id && credentials) await credentials.delete(KEY_NAME(id)).catch(() => {});
    settings.set({ tunnelId: null, use: { ...settings.get().use, chatgpt: false } });
    service.connection.set("needs-setup", "Not set up.");
    await refreshKeySaved();
    return { forgotten: true };
  },
  // ---- Claude Code ----
  addToClaude: () => {
    // Windows installs Claude Code's command as claude.cmd, which needs the shell to run.
    const r = process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", `"${claudeCommand()}"`], { encoding: "utf8", windowsHide: true, timeout: 30000, windowsVerbatimArguments: true })
      : spawnSync("claude", claudeArgs(), { encoding: "utf8", timeout: 30000 });
    if (process.platform === "win32" && /not recognized/i.test(r.stderr || "")) return { ok: false, output: "Claude Code's command (claude) wasn't found. Install Claude Code, or copy the command and run it yourself." };
    if (r.error?.code === "ENOENT") return { ok: false, output: "Claude Code's command (claude) wasn't found. Install Claude Code, or copy the command and run it yourself." };
    return { ok: r.status === 0, output: `${r.stdout || ""}${r.stderr || ""}`.trim() };
  },
  // ---- simulator ----
  simStart: (a) => service.simulator("rudi_start", a),
  simAction: ({ action, args }) => service.simulator("rudi_action", { action, ...(args?.length ? { args } : {}) }),
  simStop: ({ force }) => service.simulator("rudi_stop", {}, { force: !!force }),
  // ---- previews ----
  previewList: () => service.previewStatus(),
  previewChooseFile: async () => {
    const r = await dialog.showOpenDialog(win, { title: "Choose a Rudi-Sim project file", properties: ["openFile"], filters: [{ name: "Rudi-Sim project", extensions: ["json"] }] });
    return r.canceled ? null : service.reviewProject(r.filePaths[0]);
  },
  previewTrust: ({ path }) => service.trustProject(path),
  previewStart: ({ name }) => service.startPreview(name, (m) => send("preview-log", m)),
  previewStop: ({ name }) => service.stopPreview(name, (m) => send("preview-log", m)),
  // ---- recordings ----
  recordings: () => ({ root: service.library.root, items: service.library.list().map((r) => ({ ...r, videoUrl: r.video && existsSync(r.video) ? pathToFileURL(r.video).href : null })) }),
  recRename: ({ id, title }) => service.library.rename(id, title),
  recExport: async ({ id }) => {
    const s = service.library.get(id);
    const r = await dialog.showSaveDialog(win, { title: "Export video", defaultPath: `${s.title.replace(/[\\/:*?"<>|]+/g, "-")}.webm`, filters: [{ name: "WebM video", extensions: ["webm"] }] });
    return r.canceled ? null : service.library.exportVideo(id, r.filePath);
  },
  recDelete: async ({ id }) => {
    const s = service.library.get(id);
    const r = await dialog.showMessageBox(win, { type: "warning", buttons: ["Move to Trash", "Cancel"], defaultId: 1, cancelId: 1, message: `Delete "${s.title}"?`, detail: "The whole session folder (video and screenshots) goes to your computer's trash." });
    return r.response === 0 ? service.library.remove(id) : null;
  },
  recShow: ({ id }) => { const s = service.library.get(id); s.video ? shell.showItemInFolder(s.video) : shell.openPath(s.folder); return true; },
  recOpenRoot: () => { mkdirSync(service.library.root, { recursive: true }); shell.openPath(service.library.root); return true; },
  // ---- app ----
  openExternal: ({ url }) => { if (/^https:\/\/(platform\.openai\.com|chatgpt\.com|github\.com|nodejs\.org|claude\.com|code\.claude\.com)\//.test(url)) shell.openExternal(url); return true; },
  checkUpdates: async () => {
    try {
      const r = await fetch("https://api.github.com/repos/f-loor/rudi-sim/releases/latest", { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000) });
      if (r.status === 404) return { current: app.getVersion(), latest: null, note: "No public release has been published yet." };
      const j = await r.json();
      const latest = String(j.tag_name || "").replace(/^v/, "");
      return { current: app.getVersion(), latest, newer: !!latest && latest !== app.getVersion(), url: j.html_url };
    } catch (e) { return { current: app.getVersion(), error: `Couldn't check: ${e.message}` }; }
  },
  quit: () => { app.quit(); return true; },
};
for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle(name, async (_e, arg) => {
    try { return { ok: true, value: await fn(arg || {}) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
}

// ---- quitting: finish recordings, stop owned processes ----
app.on("before-quit", (e) => {
  if (quitting === "done") return;
  e.preventDefault();
  if (quitting) return;
  quitting = true;
  (async () => {
    try { const r = await service?.quit(); if (r?.recordingError) dialog.showErrorBox("Recording not finished", r.recordingError); }
    catch {}
    releaseLock?.();
    quitting = "done";
    app.quit();
  })();
});
// Opening Rudi-Sim again shows the window; "Rudi-Sim --quit" asks the running copy to quit.
app.on("second-instance", (_e, argv) => (argv.includes("--quit") ? app.quit() : createWindow()));
app.on("window-all-closed", () => { if (smoke) return; if (!tray || !settings.get().keepRunningInBackground) app.quit(); });
app.on("activate", () => createWindow());

// Electron can't finish loading an ES module main file that awaits "ready" at
// the top level (it waits for the module first), so start from a callback.
app.whenReady().then(async () => {
  await startService();
  await refreshKeySaved();
  setTimeout(() => { runtimeState = { checking: false, ...runtime.check() }; send("status", fullStatus()); }, 10);
  if (smoke) {
    const { runSmoke } = await import(pathToFileURL(join(here, "smoke.mjs")).href);
    const code = await runSmoke({ app, service, runtime, settings, home, launcher, out: smoke, here, engineRoot, BrowserWindow });
    quitting = "done";
    await service.quit().catch(() => {});
    releaseLock?.();
    app.exit(code);
  } else {
    try { tray = new Tray(trayIcon()); tray.on("click", () => createWindow()); updateTray(); } catch { tray = null; }
    createWindow();
    if (process.platform === "darwin" && startHidden) app.dock?.hide();
  }
}).catch((e) => { dialog.showErrorBox("Rudi-Sim couldn't start", e.stack || e.message); app.exit(1); });
