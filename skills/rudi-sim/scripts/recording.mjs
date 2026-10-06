// Where a session's screenshots and video go, what the folder is called, and
// making sure the video is finished before anyone is told it's ready.
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// The visible default folder for recordings made through the desktop companion
// or the bridge: "Rudi-Sim Recordings" in the user's home folder, unless
// RUDI_SIM_RECORDINGS names another. (The command line keeps ./rudi-sim/.)
export function recordingsRoot(env = process.env) {
  return resolve(env.RUDI_SIM_RECORDINGS || join(homedir(), "Rudi-Sim Recordings"));
}

// A folder name a person can read: project, then date and time.
// e.g. "localhost-5001_2026-10-06_04-31-22" (no spaces, so it is easy to paste into a terminal)
export function sessionName(project, when = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`;
  const clean = String(project || "rudi-sim").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "rudi-sim";
  return `${clean}_${stamp.replace(" ", "_")}`;
}

// A short project name from an address: the host, plus the port when there is one.
export function projectFromUrl(url) {
  try { const u = new URL(url); return u.port ? `${u.hostname}-${u.port}` : u.hostname; } catch { return "rudi-sim"; }
}

// Moves a closed context's video to its final name and checks it was written.
// Call only after context.close() has resolved, which is when Playwright finishes the file.
export async function finalizeVideo(video, dest) {
  if (!video) return null;
  const p = await video.path().catch(() => null);
  if (!p || !existsSync(p)) return { path: null, finalized: false, error: "The browser didn't save a video." };
  renameSync(p, dest);
  const bytes = statSync(dest).size;
  return bytes > 0 ? { path: dest, bytes, finalized: true } : { path: dest, bytes, finalized: false, error: "The video file is empty." };
}

// Written beside the files when a session ends, so the folder explains itself
// and tools can find the newest recording after the window has closed.
// `status` is recording, finalizing, ready or error. A title someone gave the
// session in the recordings library is kept when the engine rewrites the file.
export function writeManifest(dir, info) {
  const shots = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".png")).sort() : [];
  const f = join(dir, "session.json");
  let title;
  try { title = JSON.parse(readFileSync(f, "utf8")).title; } catch {}
  const manifest = { schema: 1, ...(title ? { title } : {}), ...info, folder: dir, screenshots: shots.length, lastScreenshot: shots.length ? join(dir, shots.at(-1)) : null, savedAt: new Date().toISOString() };
  // Written to a side file first, so a reader never sees half a manifest.
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  renameSync(tmp, f);
  return manifest;
}

// The newest finished session under `root` (looks one level down for session.json).
export function latestSession(root = recordingsRoot()) {
  if (!existsSync(root)) return null;
  let best = null;
  for (const name of readdirSync(root)) {
    const f = join(root, name, "session.json");
    if (!existsSync(f)) continue;
    try {
      const m = JSON.parse(readFileSync(f, "utf8"));
      if (m.status && m.status !== "ready" && m.status !== "error") continue;
      const t = Date.parse(m.savedAt) || statSync(f).mtimeMs;
      if (!best || t > best.t) best = { t, manifest: m };
    } catch {}
  }
  return best?.manifest || null;
}
