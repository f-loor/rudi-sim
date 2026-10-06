// Everything the desktop app does, without any Electron code, so the command-line
// companion can use the same thing and tests can drive it with plain Node:
// the shared simulator (hub), the ChatGPT connection, the recordings library,
// previews, and a clean shutdown.
import { join } from "node:path";
import { Bridge } from "../local-bridge/server.mjs";
import { Connection, mcpCommandFor } from "./connection.mjs";
import { Hub } from "./hub.mjs";
import { Library } from "./library.mjs";
import { loadProject, start as startPreviews, status as previewStatus, stop as stopPreviews, trust, trustedProjects } from "../../skills/rudi-sim/scripts/preview.mjs";

export class Service {
  // node/nodeEnv: how to run the engine. launcher: [program, script?] that
  // tunnel-client runs to reach this app. trash: moves a folder to the trash.
  constructor({ home, settings, credentials, node = process.execPath, nodeEnv = {}, launcher, headless = false, version = "dev", trash = null, engineArgs = [], connectionOptions = {} }) {
    Object.assign(this, { home, settings, credentials, version });
    this.bridge = new Bridge({ runtimeHome: join(home, "bridge"), node, nodeEnv, headless, recordings: () => this.settings.get().recordingsDir, extraArgs: engineArgs });
    this.hub = new Hub({ bridge: this.bridge, home, version });
    this.connection = new Connection({ home, settings, credentials, mcpCommand: launcher ? mcpCommandFor(launcher) : "", hub: this.hub, ...connectionOptions });
    this.library = new Library({ root: settings.get().recordingsDir, trash });
    this.previewsStarted = new Set();
  }

  async start() {
    await this.hub.listen();
    const s = this.settings.get();
    // A Disconnect is remembered across restarts: ChatGPT stays shut out until Connect.
    this.hub.setRemote(s.intent !== "disconnected");
    if (s.use.chatgpt) await this.connection.init();
    else this.connection.set(this.connection.ready().ok ? "disconnected" : "needs-setup", s.use.chatgpt ? null : "ChatGPT isn't set up on this computer.");
    return this;
  }

  status() {
    return { version: this.version, connection: this.connection.status(), hub: this.hub.status(), settings: this.settings.get() };
  }

  // ---- previews: commands only from a project file the person trusted ----
  previewProjects() { return trustedProjects(); }
  reviewProject(file) {
    const cfg = loadProject(file);
    return { name: cfg.name, path: cfg.path, repo: cfg.repo, original: cfg.original, proposed: cfg.proposed, commands: { install: cfg.install || null, launch: cfg.launch || null, reset: cfg.reset || null }, port: cfg.port, env: Object.keys(cfg.env || {}) };
  }
  trustProject(file) { return this.reviewProject(trust(file).path); }
  async startPreview(name, say = () => {}) {
    const p = trustedProjects().find((x) => x.name === name);
    if (!p) throw new Error(`No trusted project named "${name}".`);
    const r = await startPreviews(loadProject(p.path), { say });
    this.previewsStarted.add(p.path);
    return r;
  }
  async stopPreview(name, say = () => {}) {
    const p = trustedProjects().find((x) => x.name === name);
    if (!p) throw new Error(`No trusted project named "${name}".`);
    this.previewsStarted.delete(p.path);
    return stopPreviews(loadProject(p.path), { say });
  }
  async previewStatus() {
    const out = [];
    for (const p of trustedProjects()) { try { out.push(await previewStatus(loadProject(p.path))); } catch (e) { out.push({ project: p.name, error: e.message }); } }
    return out;
  }

  // ---- the simulator, from the app's own controls ----
  app() { return { id: "app", kind: "app", pid: process.pid }; }
  simulator(name, args, opts) { return this.hub.call(this.app(), name, args, opts); }

  // ---- recordings folder ----
  setRecordingsDir(dir, { move }) {
    if (this.bridge.running()) throw new Error("Stop the simulator before changing the recordings folder.");
    const r = this.library.relocate(dir, { move });
    this.settings.set({ recordingsDir: this.library.root });
    return r;
  }

  // Quit: stop taking calls, finish the recording, stop the tunnel, stop the
  // previews this app started, and close the hub. Returns what happened.
  async quit() {
    const report = { recording: null, recordingError: null, connection: null, previews: [] };
    this.hub.setRemote(false);
    await this.hub.drainRemote(15000);
    try { report.recording = await this.hub.stopAny(); } catch (e) { report.recordingError = e.message; }
    report.connection = await this.connection.shutdown();
    for (const path of this.previewsStarted) { try { await stopPreviews(loadProject(path), { say: () => {} }); report.previews.push(path); } catch {} }
    this.hub.close();
    return report;
  }
}
