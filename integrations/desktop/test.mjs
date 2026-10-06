#!/usr/bin/env node
// Desktop pieces that don't need a browser or Electron: key storage, settings,
// the recordings library, and the command-line companion's start, connect,
// disconnect and quit. A stand-in replaces OpenAI's tunnel-client.
// Usage: node --test integrations/desktop/test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryProvider, store, systemProvider } from "./credentials.mjs";
import { Settings } from "./settings.mjs";
import { Library, sessionState } from "./library.mjs";
import { explain } from "./runtime.mjs";
import { alive } from "../../skills/rudi-sim/scripts/proc.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const KEY = "sk-test-not-a-real-key-123";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };
// Folder names with a space and non-ASCII letters, like many real user folders.
const tmp = () => mkdtempSync(join(tmpdir(), "rudi desktop Zoë-"));

test("credential names and keys are checked before they reach the store", async () => {
  const s = store(memoryProvider());
  await s.set("tunnel:rudi-sim", KEY);
  assert.equal(await s.get("tunnel:rudi-sim"), KEY);
  await assert.rejects(s.set("tunnel:rudi-sim", "two\nlines"));
  await assert.rejects(s.set("tunnel:rudi-sim", 'has"quote'));
  await assert.rejects(s.get("bad name with spaces"));
  assert.equal(await s.delete("tunnel:rudi-sim"), true);
  assert.equal(await s.get("tunnel:rudi-sim"), null);
});

// On Windows this uses the real Credential Manager with a throwaway entry.
test("the system secret store saves, reads and deletes a key", async (t) => {
  const p = systemProvider();
  if (!p) return t.skip("no secret store on this computer (Linux without secret-tool)");
  const s = store(p), name = `tunnel:ci-${process.pid}`;
  try { await s.set(name, KEY); }
  catch (e) { if (process.platform !== "win32") return t.skip(`${p.label} isn't usable here: ${e.message}`); throw e; }
  try { assert.equal(await s.get(name), KEY); }
  finally { await s.delete(name); }
  assert.equal(await s.get(name), null);
});

test("settings never hold a key, and survive in a folder with spaces and non-ASCII letters", () => {
  const home = tmp();
  try {
    const s = new Settings(home, { ...process.env, RUDI_SIM_RECORDINGS: join(home, "Récordings") });
    assert.equal(s.get().recordingsDir, join(home, "Récordings"));
    assert.throws(() => s.set({ apiKey: KEY }), /secret store/);
    s.set({ tunnelId: "tunnel_0123456789abcdef", intent: "disconnected" });
    assert.equal(new Settings(home).get().intent, "disconnected");
    assert.ok(!readFileSync(join(home, "settings.json"), "utf8").includes(KEY));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("recordings library: states, rename, export, delete, moving the folder, missing files", async () => {
  const home = tmp(), root = join(home, "Recordings ü"), other = join(home, "Elsewhere");
  const session = (id, m, video = true) => {
    const d = join(root, id); mkdirSync(d, { recursive: true });
    if (video) writeFileSync(join(d, "walkthrough-1-screens.webm"), "webm-bytes");
    writeFileSync(join(d, "shot-1.png"), "png");
    if (m) writeFileSync(join(d, "session.json"), JSON.stringify({ folder: d, ...m, videos: video ? [{ path: join(d, "walkthrough-1-screens.webm"), bytes: 10, finalized: true, durationMs: 4200 }] : [] }));
    return d;
  };
  try {
    session("site_2026-10-06_10-00-00", { status: "ready", project: "site", startedAt: "2026-10-06T10:00:00Z", stoppedAt: "2026-10-06T10:00:05Z", devices: ["iPhone 17"] });
    session("live_2026-10-06_11-00-00", { status: "recording", pid: process.pid, startedAt: "2026-10-06T11:00:00Z" }, false);
    session("crashed_2026-10-06_09-00-00", { status: "recording", pid: 999999, startedAt: "2026-10-06T09:00:00Z" }, false);
    const gone = session("gone_2026-10-06_08-00-00", { status: "ready", startedAt: "2026-10-06T08:00:00Z" });
    rmSync(join(gone, "walkthrough-1-screens.webm"));
    session("old-folder", null);
    const lib = new Library({ root });
    const byId = Object.fromEntries(lib.list().map((s) => [s.id, s]));
    assert.equal(byId["site_2026-10-06_10-00-00"].state, "ready");
    assert.equal(byId["site_2026-10-06_10-00-00"].durationMs, 4200);
    assert.deepEqual(byId["site_2026-10-06_10-00-00"].devices, ["iPhone 17"]);
    assert.equal(byId["live_2026-10-06_11-00-00"].state, "recording");
    assert.equal(byId["crashed_2026-10-06_09-00-00"].state, "interrupted");
    assert.match(byId["crashed_2026-10-06_09-00-00"].detail, /1 screenshot is still in the folder/);
    assert.equal(byId["gone_2026-10-06_08-00-00"].state, "error");
    assert.match(byId["gone_2026-10-06_08-00-00"].detail, /missing/);
    assert.equal(byId["old-folder"].state, "ready", "folders from before manifests still show");

    const renamed = lib.rename("site_2026-10-06_10-00-00", "Checkout on iPhone");
    assert.equal(renamed.title, "Checkout on iPhone");
    assert.equal(new Library({ root }).get("site_2026-10-06_10-00-00").title, "Checkout on iPhone", "kept after a restart");
    assert.throws(() => lib.rename("live_2026-10-06_11-00-00", "x"), /Wait until/);
    const out = join(home, "export ä.webm");
    lib.exportVideo("site_2026-10-06_10-00-00", out);
    assert.equal(readFileSync(out, "utf8"), "webm-bytes");
    assert.throws(() => lib.folderOf("../outside"), /isn't in the recordings folder/);
    await assert.rejects(lib.remove("live_2026-10-06_11-00-00"), /still being recorded/);
    const trashed = [];
    const withTrash = new Library({ root, trash: async (f) => { trashed.push(f); rmSync(f, { recursive: true }); } });
    await withTrash.remove("gone_2026-10-06_08-00-00");
    assert.equal(trashed.length, 1, "deleting uses the trash when there is one");

    // A new folder, moving finished sessions; the live one stays.
    const r = lib.relocate(other, { move: true });
    assert.ok(r.moved.includes("site_2026-10-06_10-00-00"));
    assert.deepEqual(r.skipped.map((x) => x.id), ["live_2026-10-06_11-00-00"]);
    const moved = new Library({ root: other }).get("site_2026-10-06_10-00-00");
    assert.equal(moved.state, "ready", "the video is found beside the moved manifest");
    assert.equal(moved.title, "Checkout on iPhone");
    // Or keep them where they were.
    const keep = new Library({ root: other }).relocate(join(home, "Third"), { move: false });
    assert.deepEqual(keep.moved, []);
    assert.ok(existsSync(join(other, "site_2026-10-06_10-00-00")));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("download errors are explained in plain words", () => {
  assert.match(explain("Error: getaddrinfo ENOTFOUND cdn.playwright.dev"), /internet connection/);
  assert.match(explain("ENOSPC: no space left on device"), /disk space/);
  assert.match(explain("Error: 407 Proxy Authentication Required"), /proxy/);
  void sessionState;
});

test("command line: start once, connect without the key again, disconnect is kept, quit stops everything", async () => {
  const home = tmp();
  const control = join(home, "control.json");
  writeFileSync(control, JSON.stringify({ readyz: 200, controlPlane: { status: "ok" } }));
  const env = { ...process.env, RUDI_SIM_DESKTOP_HOME: home, RUDI_SIM_CREDENTIAL_PROVIDER: "env-for-tests", RUDI_SIM_TEST_KEY: KEY, RUDI_SIM_TEST_TUNNEL: JSON.stringify([process.execPath, join(here, "fake-tunnel.mjs")]), FAKE_TUNNEL_CONTROL: control, RUDI_SIM_RECORDINGS: join(home, "rec") };
  writeFileSync(join(home, "settings.json"), JSON.stringify({ tunnelClient: process.execPath, tunnelId: "tunnel_0123456789abcdef", use: { claude: true, chatgpt: true } }));
  const cli = (...a) => { const r = spawnSync(process.execPath, [join(here, "rudi-sim-desktop.mjs"), ...a], { env, encoding: "utf8", timeout: 120000 }); return { code: r.status, text: r.stdout + r.stderr }; };
  const json = () => JSON.parse(cli("status", "--json").text);
  const state = () => JSON.parse(readFileSync(join(home, "companion.json"), "utf8"));
  try {
    let r = cli("start");
    assert.equal(r.code, 0, r.text); assert.match(r.text, /Started in the background/);
    assert.ok(await until(() => json().connection?.state === "connected"), JSON.stringify(json()));
    const first = state();
    assert.match(cli("start").text, /Already running/);
    assert.equal(state().pid, first.pid, "no second copy");
    r = cli("disconnect");
    assert.match(r.text, /Disconnected/, r.text);
    assert.equal(json().connection.state, "disconnected");
    // Restarting the companion keeps the choice.
    cli("quit");
    assert.ok(await until(() => !alive(first.pid)));
    cli("start");
    assert.ok(await until(() => json().connection?.state === "disconnected"));
    r = cli("connect");
    assert.ok(await until(() => json().connection?.state === "connected"), "connects with the saved key");
    r = cli("restart");
    assert.ok(await until(() => json().connection?.state === "connected"));
    const pid = state().pid;
    r = cli("quit");
    assert.match(r.text, /Stopped/, r.text);
    assert.ok(await until(() => !alive(pid)));
    const owned = JSON.parse(readFileSync(join(home, "owned-tunnels.json"), "utf8"));
    assert.ok(owned.every((o) => !alive(o.pid)), "no tunnel left running");
    assert.match(cli("quit").text, /Not running/);
    assert.match(cli("claude-command").text, /claude mcp add --scope user rudi-sim -- ".+" ".+server\.mjs" --client claude/);
  } finally { cli("quit"); rmSync(home, { recursive: true, force: true }); }
});
