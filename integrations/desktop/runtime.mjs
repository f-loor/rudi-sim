// Safari's engine (Playwright's WebKit) for the desktop app. The app ships
// Playwright itself and its own Node runtime (Electron run as Node), so people
// never install Node; WebKit (about 70-90 MB) is downloaded on first use into
// the app's data folder, with progress, and can be retried.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// node: how to run Node (the app passes its own executable + ELECTRON_RUN_AS_NODE).
export class Runtime {
  constructor({ playwrightDir, browsersDir, node = process.execPath, nodeEnv = {} }) {
    Object.assign(this, { playwrightDir, browsersDir, node, nodeEnv });
  }
  env() { return { ...process.env, ...this.nodeEnv, PLAYWRIGHT_BROWSERS_PATH: this.browsersDir, RUDI_SIM_PLAYWRIGHT: this.playwrightDir, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "" }; }

  // { ok, webkit: path|null, version, error }
  check() {
    if (!existsSync(join(this.playwrightDir, "package.json"))) return { ok: false, webkit: null, error: "Playwright is missing from this copy of Rudi-Sim. Reinstall the app." };
    const script = `const p=require(${JSON.stringify(this.playwrightDir)});const fs=require("fs");const e=p.webkit.executablePath();console.log(JSON.stringify({path:e,exists:fs.existsSync(e),version:require(${JSON.stringify(join(this.playwrightDir, "package.json"))}).version}))`;
    const r = spawnSync(this.node, ["-e", script], { env: this.env(), encoding: "utf8", windowsHide: true, timeout: 30000 });
    try {
      const o = JSON.parse(r.stdout.trim().split("\n").pop());
      return { ok: o.exists, webkit: o.exists ? o.path : null, playwright: o.version, error: o.exists ? null : "Safari's engine isn't downloaded yet." };
    } catch { return { ok: false, webkit: null, error: `Couldn't check for Safari's engine: ${(r.stderr || r.error?.message || "").trim().split("\n")[0]}` }; }
  }

  // Downloads WebKit and the video encoder Playwright records with. onProgress({ percent, line }). Resolves { ok, error, log }.
  install({ onProgress = () => {}, signal } = {}) {
    mkdirSync(this.browsersDir, { recursive: true });
    return new Promise((done) => {
      const c = spawn(this.node, [join(this.playwrightDir, "cli.js"), "install", "webkit", "ffmpeg"], { env: this.env(), windowsHide: true, signal });
      let log = "";
      const on = (d) => {
        const t = String(d); log = (log + t).slice(-8000);
        for (const line of t.split(/[\r\n]+/).filter(Boolean)) {
          const m = line.match(/(\d{1,3})%/);
          onProgress({ percent: m ? Number(m[1]) : null, line: line.replace(/\s+/g, " ").trim().slice(0, 200) });
        }
      };
      c.stdout.on("data", on); c.stderr.on("data", on);
      c.once("error", (e) => done({ ok: false, error: explain(e.message), log }));
      c.once("exit", (code) => done(code === 0 ? { ok: true, log } : { ok: false, error: explain(log), log }));
    });
  }
}

// Plain-language reasons for common download failures.
export function explain(text) {
  const t = String(text);
  if (/ENOSPC|no space/i.test(t)) return "There isn't enough free disk space. Free up about 500 MB and try again.";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(t)) return "Couldn't reach the download server. Check your internet connection and try again.";
  if (/ECONNRESET|ETIMEDOUT|socket hang up|timed? ?out/i.test(t)) return "The download was interrupted. Try again; it continues from a fresh start.";
  if (/403|407|proxy|certificate|self.signed|UNABLE_TO_VERIFY/i.test(t)) return "A network filter or proxy blocked the download (common on work networks). Try another network, or ask your IT team to allow playwright.azureedge.net and cdn.playwright.dev.";
  if (/EACCES|EPERM|permission/i.test(t)) return "Rudi-Sim couldn't write to its data folder. Check that your user account can write to it.";
  if (/abort/i.test(t)) return "The download was cancelled.";
  const last = t.trim().split("\n").filter(Boolean).pop() || "Unknown error";
  return `The download failed: ${last.slice(0, 200)}`;
}
