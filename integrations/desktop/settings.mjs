// Settings for the desktop app and the command-line companion, in one small
// JSON file in the user's own profile folder. Never the tunnel key: that lives
// in the system's secret store (credentials.mjs).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { recordingsRoot } from "../../skills/rudi-sim/scripts/recording.mjs";

export const desktopHome = (env = process.env) => resolve(env.RUDI_SIM_DESKTOP_HOME || join(homedir(), ".rudi-sim-desktop"));

export const DEFAULTS = (env = process.env) => ({
  setupDone: false,
  use: { claude: true, chatgpt: false },  // which assistants this computer is set up for
  recordingsDir: recordingsRoot(env),
  startAtLogin: false,
  keepRunningInBackground: true,           // closing the window keeps Rudi-Sim in the tray / menu bar
  tunnelClient: null,                      // full path to OpenAI's tunnel-client
  tunnelId: null,
  intent: "connected",                     // "disconnected" after the person chose Disconnect
  devices: "iPhone 17, iPad mini, MacBook Air 13",
  landscape: false,
  customSizes: [],
});

const SECRETISH = /key|secret|token|password/i;

export class Settings {
  constructor(home = desktopHome(), env = process.env) { this.home = home; this.file = join(home, "settings.json"); this.env = env; }
  get() {
    let saved = {};
    try { saved = JSON.parse(readFileSync(this.file, "utf8")); } catch {}
    return { ...DEFAULTS(this.env), ...saved, use: { ...DEFAULTS(this.env).use, ...(saved.use || {}) } };
  }
  set(patch) {
    for (const k of Object.keys(patch)) if (SECRETISH.test(k)) throw new Error(`"${k}" can't be saved in settings; keys go in the system's secret store.`);
    const next = { ...this.get(), ...patch };
    mkdirSync(this.home, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    return next;
  }
}
