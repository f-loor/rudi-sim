// The recordings library: every session folder in the recordings folder, read
// from the session.json the engine writes, with its state worked out safely.
// Nothing is deleted without an explicit call, and deleting moves to the
// computer's trash when the caller provides one.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, isAbsolute } from "node:path";
import { alive } from "../../skills/rudi-sim/scripts/proc.mjs";

// States: recording, finalizing, ready, interrupted (ended without finishing), error.
export function sessionState(m, folder) {
  const vids = (m.videos || []).map((v) => ({ ...v, exists: !!v.path && existsSync(v.path) }));
  if ((m.status === "recording" || m.status === "finalizing") && m.pid && alive(m.pid)) return { state: m.status, detail: m.status === "recording" ? "Recording now." : "Saving the video…" };
  if (m.status === "recording" || m.status === "finalizing") {
    const shots = readdirSync(folder).filter((f) => f.endsWith(".png")).length;
    return { state: "interrupted", detail: `This session ended before its video was saved (Rudi-Sim was closed or crashed).${shots ? ` ${shots} screenshot${shots === 1 ? " is" : "s are"} still in the folder.` : ""}` };
  }
  if (!vids.length) return m.status === "error" ? { state: "error", detail: "No video was saved." } : { state: "ready", detail: "Screenshots only." };
  if (!vids.some((v) => v.exists)) return { state: "error", detail: "The video file is missing (moved or deleted outside Rudi-Sim)." };
  if (m.status === "error" || vids.some((v) => !v.finalized)) return { state: "error", detail: vids.find((v) => v.error)?.error || "The video wasn't finished." };
  return { state: "ready", detail: null };
}

export class Library {
  constructor({ root, trash = null }) { this.root = resolve(root); this.trash = trash; }

  // Folders straight inside the root that are sessions (have session.json or a .webm).
  list() {
    if (!existsSync(this.root)) return [];
    const out = [];
    for (const name of readdirSync(this.root)) {
      const folder = join(this.root, name);
      let st; try { st = statSync(folder); } catch { continue; }
      if (!st.isDirectory()) continue;
      const f = join(folder, "session.json");
      let m = null;
      try { m = JSON.parse(readFileSync(f, "utf8")); } catch {}
      if (!m) {
        // A folder from before manifests existed: show its videos as they are.
        const webms = readdirSync(folder).filter((x) => x.endsWith(".webm"));
        if (!webms.length) continue;
        m = { status: "ready", videos: webms.map((w) => ({ path: join(folder, w), bytes: statSync(join(folder, w)).size, finalized: true })), startedAt: st.mtime.toISOString(), legacy: true };
      }
      // Paths in a manifest written before the folder was moved: look beside it instead.
      m.videos = (m.videos || []).map((v) => (v.path && !existsSync(v.path) && existsSync(join(folder, basename(v.path))) ? { ...v, path: join(folder, basename(v.path)) } : v));
      const s = sessionState(m, folder);
      const video = m.videos.find((v) => v.path && existsSync(v.path)) || null;
      out.push({
        id: name, folder, title: m.title || m.project || name, project: m.project || null,
        url: m.url || null, compare: m.compare || null, devices: m.devices || [], landscape: !!m.landscape, theme: m.theme || null,
        startedAt: m.startedAt || null, stoppedAt: m.stoppedAt || null,
        durationMs: video?.durationMs ?? (m.startedAt && m.stoppedAt ? Date.parse(m.stoppedAt) - Date.parse(m.startedAt) : null),
        video: video?.path || null, bytes: video?.bytes ?? null, screenshots: m.screenshots ?? null,
        state: s.state, detail: s.detail, legacy: !!m.legacy,
      });
    }
    return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  // The folder for an id, only if it is directly inside the library (never elsewhere).
  folderOf(id) {
    const folder = resolve(this.root, String(id));
    const rel = relative(this.root, folder);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/") || rel.includes("\\") || !existsSync(folder)) throw new Error("That recording isn't in the recordings folder.");
    return folder;
  }
  get(id) { const s = this.list().find((x) => x.id === id); if (!s) throw new Error("That recording isn't in the recordings folder."); return s; }

  rename(id, title) {
    const t = String(title || "").trim().slice(0, 120);
    if (!t) throw new Error("Give the recording a name.");
    const folder = this.folderOf(id), f = join(folder, "session.json");
    let m = {}; try { m = JSON.parse(readFileSync(f, "utf8")); } catch {}
    if (m.status === "recording" || m.status === "finalizing") { if (m.pid && alive(m.pid)) throw new Error("Wait until the recording has finished."); }
    const next = { ...m, title: t, folder };
    if (!m.status) Object.assign(next, { status: "ready", videos: this.get(id).video ? [{ path: this.get(id).video, finalized: true }] : [] });
    writeFileSync(`${f}.tmp`, JSON.stringify(next, null, 2)); renameSync(`${f}.tmp`, f);
    return this.get(id);
  }

  exportVideo(id, dest) {
    const s = this.get(id);
    if (s.state !== "ready" || !s.video) throw new Error("Only a finished recording can be exported.");
    copyFileSync(s.video, dest);
    return dest;
  }

  // Deletes a whole session folder. Uses the computer's trash when available.
  async remove(id) {
    const folder = this.folderOf(id);
    const s = this.get(id);
    if (s.state === "recording" || s.state === "finalizing") throw new Error("This session is still being recorded.");
    if (this.trash) await this.trash(folder);
    else rmSync(folder, { recursive: true, force: true });
    return { removed: folder, trashed: !!this.trash };
  }

  // A new recordings folder. move=true moves finished sessions there (sessions
  // still recording stay where they are); move=false leaves them where they were.
  relocate(newRoot, { move = false } = {}) {
    const dest = resolve(newRoot);
    if (dest === this.root) return { moved: [], skipped: [] };
    const rel = relative(this.root, dest);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) throw new Error("Choose a folder that isn't inside the current recordings folder.");
    mkdirSync(dest, { recursive: true });
    const moved = [], skipped = [];
    if (move) for (const s of this.list()) {
      if (s.state === "recording" || s.state === "finalizing") { skipped.push({ id: s.id, why: "still recording" }); continue; }
      const to = join(dest, s.id);
      if (existsSync(to)) { skipped.push({ id: s.id, why: "a folder with that name is already there" }); continue; }
      try { renameSync(s.folder, to); }
      catch (e) {
        if (e.code !== "EXDEV") { skipped.push({ id: s.id, why: e.message }); continue; }
        cpSync(s.folder, to, { recursive: true }); rmSync(s.folder, { recursive: true, force: true });
      }
      moved.push(s.id);
    }
    this.root = dest;
    return { moved, skipped };
  }
}
