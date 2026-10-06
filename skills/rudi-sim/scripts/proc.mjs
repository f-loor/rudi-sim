// Knowing which processes are really ours. A process id alone isn't proof:
// after a restart or a crash the same number can belong to something else. So
// Rudi-Sim records a process's id together with when it started (and part of
// its command line), and only stops a process when all of them still match.
import { spawnSync } from "node:child_process";
import { linkSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// Runs a PowerShell snippet on Windows and returns what it printed. The script
// goes in as UTF-16 and comes back as UTF-8, so folder names like "Zoë" survive
// both ways (the console's own code page would mangle them, and a tunnel in such
// a folder would then look like a stranger and never be stopped).
export function powershell(script, timeout = 15000) {
  const full = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(full, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout });
  return r.stdout || "";
}

// { pid, started, command } for a running process, or null when it isn't running.
// `started` is the operating system's own start time, as text: it only has to be
// compared with itself.
export function identify(pid) {
  if (!alive(pid)) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 22 (start time in clock ticks since boot), counted after the ")" that ends the name.
      const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      return { pid, started, command };
    }
    if (process.platform === "win32") {
      const out = powershell(`$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){$p.CreationDate.ToUniversalTime().ToString('o'); $p.CommandLine}`);
      const [started, ...rest] = out.split(/\r?\n/);
      return started?.trim() ? { pid, started: started.trim(), command: rest.join(" ").trim() } : null;
    }
    // macOS and other Unix systems.
    const r = spawnSync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
    const line = (r.stdout || "").trim();
    if (!line) return null;
    return { pid, started: line.slice(0, 24).trim(), command: line.slice(24).trim() };
  } catch { return null; }
}

// What to save about a process we just started, so we can recognise it later.
// `marker` is a piece of its command line that must still be there.
export function remember(pid, marker = null, extra = {}) {
  const id = identify(pid);
  return { pid, started: id?.started ?? null, marker, ...extra };
}

// Is the saved process still the one we started?
export function isSame(rec) {
  if (!rec?.pid) return false;
  const now = identify(rec.pid);
  if (!now) return false;
  // Without a recorded start time we can't be sure, so the answer is no.
  if (!rec.started || now.started !== rec.started) return false;
  if (rec.marker && !now.command.includes(rec.marker)) return false;
  return true;
}

// Stops a process and everything it started (a dev server's own children too).
export function killTree(pid) {
  if (!alive(pid)) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else { try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} } }
}

// Stops `rec` only if it is still the process we started; waits until it has gone.
// Returns "stopped", "gone" (it had already ended) or "not-ours" (left alone).
export async function stopOwned(rec, { timeoutMs = 8000 } = {}) {
  if (!rec?.pid || !alive(rec.pid)) return "gone";
  if (!isSame(rec)) return "not-ours";
  killTree(rec.pid);
  const end = Date.now() + timeoutMs;
  while (alive(rec.pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  if (alive(rec.pid) && process.platform !== "win32") {
    try { process.kill(-rec.pid, "SIGKILL"); } catch { try { process.kill(rec.pid, "SIGKILL"); } catch {} }
    const end2 = Date.now() + 3000;
    while (alive(rec.pid) && Date.now() < end2) await new Promise((r) => setTimeout(r, 100));
  }
  return alive(rec.pid) ? "still-running" : "stopped";
}

// One holder at a time, decided by the file system: creating the lock file
// either succeeds or fails, so two starts at the same moment can't both win.
// A lock left by a process that has ended (or whose id now belongs to another
// program) is taken over. Returns a release function, or null if it's held.
export function acquireLock(file, meta = {}) {
  const me = { ...remember(process.pid), ...meta, at: new Date().toISOString() };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, JSON.stringify(me)); closeSync(fd);
      return () => { try { if (JSON.parse(readFileSync(file, "utf8")).pid === process.pid) rmSync(file, { force: true }); } catch {} };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let held;
    try { held = JSON.parse(readFileSync(file, "utf8")); }
    catch { held = null; }
    // Being written right now by another starter: give it a moment.
    if (!held) { sleepSync(50); continue; }
    if (held.pid === process.pid) return () => rmSync(file, { force: true });
    if (isSame(held) || (alive(held.pid) && !held.started)) return null;
    // Stale. Move it aside (only one starter can move it), check it was the
    // stale one we looked at, then try to create ours again.
    const aside = `${file}.stale-${randomBytes(4).toString("hex")}`;
    try { renameSync(file, aside); } catch { continue; }
    let moved = null;
    try { moved = JSON.parse(readFileSync(aside, "utf8")); } catch {}
    if (moved && (moved.pid !== held.pid || moved.at !== held.at)) {
      // Another starter took the lock in between; put theirs back.
      try { linkSync(aside, file); } catch {}
    }
    rmSync(aside, { force: true });
  }
  return null;
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
