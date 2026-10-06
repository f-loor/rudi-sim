// The installed app's self-test (Rudi-Sim --smoke-test=<results.json>). CI runs
// it on Windows and macOS after installing the real build. It exercises the
// same paths a person uses: the window loads, Safari's engine is present (or is
// downloaded, including a failed download and a retry), Claude Code connects
// through the app's own runtime, ChatGPT is refused while Claude is using the
// simulator, the recording is saved, indexed and plays inside the app, and,
// when a stand-in tunnel is given, connect / disconnect during a recording /
// connect / restart never leave two tunnels running. Quitting must leave no
// process behind. Results and timings go to the JSON file.
import { spawn } from "node:child_process";
import http from "node:http";
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150); } return false; };

// A minimal MCP client over stdio, started the way Claude Code starts Rudi-Sim.
function mcpClient(cmd, args, env) {
  const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const waiting = new Map(); let id = 0, err = "";
  child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
  createInterface({ input: child.stdout }).on("line", (l) => { try { const m = JSON.parse(l); waiting.get(m.id)?.(m); waiting.delete(m.id); } catch {} });
  const rpc = (method, params, ms = 120000) => new Promise((ok, fail) => {
    const n = ++id;
    const t = setTimeout(() => fail(new Error(`${method} timed out. ${err}`)), ms);
    waiting.set(n, (m) => { clearTimeout(t); ok(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });
  return {
    child, stderr: () => err,
    async init(name) { const r = await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name, version: "smoke" } }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); return r; },
    tool: async (name, args) => (await rpc("tools/call", { name, arguments: args })).result,
    close: () => new Promise((ok) => { if (child.exitCode !== null) return ok(); child.once("exit", ok); child.stdin.end(); setTimeout(() => { child.kill(); ok(); }, 5000); }),
  };
}
const body = (r) => { try { return JSON.parse(r?.content?.find((c) => c.type === "text")?.text); } catch { return null; } };

// Two small pages, the "before" and "after" of a site.
function testSite() {
  const page = (title, color) => `<!doctype html><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:20px system-ui;background:${color};margin:0;padding:24px"><h1>${title}</h1><a href="/next">Next page</a><p style="height:1400px">Scroll me</p>`;
  const make = (title, color) => http.createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(page(`${title} ${req.url}`, color)));
  const a = make("Before", "#eef"), b = make("After", "#efe");
  return Promise.all([a, b].map((s) => new Promise((ok) => s.listen(0, "127.0.0.1", ok)))).then(() => ({
    a: `http://127.0.0.1:${a.address().port}/`, b: `http://127.0.0.1:${b.address().port}/`, close: () => { a.close(); b.close(); },
  }));
}

export async function runSmoke({ app, service, runtime, settings, home, out, here, engineRoot, BrowserWindow }) {
  const env = process.env;
  const { alive } = await import(pathToFileURL(join(engineRoot, "skills/rudi-sim/scripts/proc.mjs")).href);
  const steps = [];
  const result = {
    ok: false, platform: `${process.platform}-${process.arch}`, appVersion: app.getVersion(), packaged: app.isPackaged,
    versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, playwright: null },
    engine: env.RUDI_SIM_ENGINE || "webkit", home, startedAt: new Date().toISOString(), steps,
  };
  const save = () => { try { writeFileSync(out, JSON.stringify(result, null, 2)); } catch (e) { console.error(`Couldn't write ${out}: ${e.message}`); } };
  async function step(name, fn, { optional = false } = {}) {
    const t = Date.now();
    try {
      const detail = await fn();
      const skipped = detail && typeof detail === "object" && detail.skipped;
      steps.push({ name, ok: true, ms: Date.now() - t, ...(skipped ? { skipped: true } : {}), detail: skipped ? detail.skipped : detail ?? null });
      console.log(`${skipped ? "–" : "✓"} ${name} (${Date.now() - t} ms)${skipped ? `: skipped, ${detail.skipped}` : ""}`);
      return detail;
    } catch (e) {
      steps.push({ name, ok: optional, failed: true, ms: Date.now() - t, error: e.message });
      console.log(`✗ ${name} (${Date.now() - t} ms): ${e.message}`);
      return undefined;
    } finally { save(); }
  }
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };
  const bridgeScript = join(engineRoot, "integrations", "local-bridge", "server.mjs");
  const bridgeEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
  let site = null, claude = null, gpt = null, recording = null;

  await step("the window and setup guide load without errors", async () => {
    const w = new BrowserWindow({ show: false, webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true } });
    const problems = [];
    w.webContents.on("console-message", (e) => { const m = e.message ?? e; if (/error|refused|violat/i.test(String(m))) problems.push(String(m)); });
    await w.loadFile(join(here, "ui", "index.html"));
    must(await until(() => w.webContents.executeJavaScript(`!document.getElementById("main").hidden || !document.getElementById("wizard").hidden`), 20000), "neither the app nor the setup guide appeared");
    const shown = await w.webContents.executeJavaScript(`document.getElementById("wizard").hidden ? "app" : "setup guide"`);
    w.destroy();
    must(!problems.length, problems.join(" | "));
    return `${shown} shown`;
  });

  await step("Safari's engine is installed (downloading it if needed)", async () => {
    let r = runtime.check();
    result.versions.playwright = r.playwright || null;
    if (r.ok) return `ready at ${r.webkit}`;
    if (env.RUDI_SIM_ENGINE && env.RUDI_SIM_ENGINE !== "webkit") return { skipped: `this run uses ${env.RUDI_SIM_ENGINE}; ${r.error}` };
    // A download through a proxy that doesn't exist must fail with a plain reason, then a retry must work.
    const Bad = runtime.constructor;
    const bad = new Bad({ playwrightDir: runtime.playwrightDir, browsersDir: runtime.browsersDir, node: runtime.node, nodeEnv: { ...runtime.nodeEnv, HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" } });
    const t0 = Date.now();
    const failed = await bad.install({});
    must(!failed.ok, "the download through a broken proxy should have failed");
    const progress = [];
    const t1 = Date.now();
    const good = await runtime.install({ onProgress: (p) => p.percent != null && progress.push(p.percent) });
    must(good.ok, `retry failed: ${good.error}`);
    r = runtime.check();
    must(r.ok, r.error);
    return { failedWith: failed.error, failMs: t1 - t0, downloadMs: Date.now() - t1, progressUpdates: progress.length, webkit: r.webkit };
  });

  site = await testSite();

  await step("Claude Code connects through the app's own runtime and opens two screens with a comparison", async () => {
    claude = mcpClient(process.execPath, [bridgeScript, "--client", "claude", "--hub-only"], bridgeEnv);
    const init = await claude.init("claude-code");
    must(init.result?.serverInfo, `no answer to initialize: ${JSON.stringify(init)} ${claude.stderr()}`);
    const r = await claude.tool("rudi_start", { url: site.a, compareUrl: site.b, device: "iPhone 17, 390x844" });
    const j = body(r);
    must(!r.isError, `start failed: ${j?.error || JSON.stringify(r).slice(0, 400)}`);
    must(j?.panes?.length >= 2 && j.panes.every((p) => p.state === "ready"), `screens not ready: ${JSON.stringify(j?.panes)}`);
    must(service.hub.status().simulator.ownerKind === "claude", "the app should show Claude as the simulator's user");
    return `${j.panes.length} screens ready`;
  });

  await step("Claude looks, clicks and retries", async () => {
    const look = await claude.tool("rudi_action", { action: "look" });
    must(!look.isError && look.content.some((c) => c.type === "image"), "no screenshot");
    const click = await claude.tool("rudi_action", { action: "click", args: ["Next page"] });
    must(!click.isError, `click failed: ${body(click)?.error}`);
    const retry = await claude.tool("rudi_action", { action: "retry" });
    must(!retry.isError, `retry failed: ${body(retry)?.error}`);
    return "screenshot, click and retry worked";
  });

  await step("ChatGPT is told the simulator is busy (no takeover)", async () => {
    gpt = mcpClient(process.execPath, [bridgeScript, "--client", "chatgpt", "--hub-only"], bridgeEnv);
    await gpt.init("openai-mcp");
    const r = await gpt.tool("rudi_start", { url: site.a });
    const j = body(r);
    must(r.isError && j?.conflict, `expected a conflict, got ${JSON.stringify(j)}`);
    must(/Claude/i.test(j.error), `the message should name Claude: ${j.error}`);
    must(service.hub.status().simulator.ownerKind === "claude", "Claude must still own the simulator");
    await gpt.close(); gpt = null;
    return j.error;
  });

  await step("stopping saves the recording", async () => {
    const r = await claude.tool("rudi_stop", {});
    const j = body(r);
    must(!r.isError, `stop failed: ${j?.error}`);
    recording = j.recording;
    must(recording?.video && existsSync(recording.video) && statSync(recording.video).size > 0, `no video: ${JSON.stringify(j).slice(0, 400)}`);
    await claude.close(); claude = null;
    return { video: recording.video, bytes: statSync(recording.video).size };
  });

  let item = null;
  await step("the recording shows up in Recordings as ready", async () => {
    item = service.library.list().find((s) => s.video === recording.video || s.folder === recording.folder);
    must(item, `not in the library: ${JSON.stringify(service.library.list().map((s) => s.id))}`);
    must(item.state === "ready", `state is ${item.state}: ${item.detail}`);
    must(item.durationMs > 0, "no duration");
    return { id: item.id, durationMs: item.durationMs, devices: item.devices };
  });

  await step("the video plays inside the app", async () => {
    const page = join(home, "smoke-player.html");
    writeFileSync(page, `<!doctype html><video id=v muted preload=auto src="${pathToFileURL(item.video).href}"></video>`);
    const w = new BrowserWindow({ show: false });
    await w.loadFile(page);
    const r = await w.webContents.executeJavaScript(`new Promise((ok) => { const v = document.getElementById("v"); const done = () => ok({ w: v.videoWidth, h: v.videoHeight, error: v.error && v.error.code }); if (v.readyState >= 2) done(); v.addEventListener("loadeddata", done); v.addEventListener("error", done); setTimeout(done, 15000); })`);
    w.destroy();
    must(!r.error && r.w > 0 && r.h > 0, `the video didn't load: ${JSON.stringify(r)}`);
    return `${r.w}×${r.h}`;
  });

  // Pictures of the real window, saved beside the results for people to check.
  await step("screenshots of the app's tabs", async () => {
    const w = new BrowserWindow({ show: false, width: 1180, height: 820, webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true } });
    await w.loadFile(join(here, "ui", "index.html"));
    await until(() => w.webContents.executeJavaScript(`!document.getElementById("main").hidden || !document.getElementById("wizard").hidden`), 20000);
    const shots = [];
    const snap = async (name) => { await sleep(600); const f = out.replace(/\.json$/i, "") + `-${name}.png`; writeFileSync(f, (await w.webContents.capturePage()).toPNG()); shots.push(f); };
    if (await w.webContents.executeJavaScript(`!document.getElementById("wizard").hidden`)) { await snap("setup-guide"); await w.webContents.executeJavaScript(`document.getElementById("wizard").hidden = true; document.getElementById("main").hidden = false;`); }
    for (const tab of ["home", "sim", "recordings", "settings"]) {
      await w.webContents.executeJavaScript(`document.querySelector('nav [data-tab="${tab}"]').click()`);
      if (tab === "recordings") { await sleep(500); await w.webContents.executeJavaScript(`document.querySelector('#rList li[data-id]')?.click()`); }
      await snap(tab);
    }
    const playable = await w.webContents.executeJavaScript(`new Promise((ok) => { const v = document.getElementById("rVideo"); if (!v) return ok(false); if (v.readyState >= 1) return ok(true); v.onloadedmetadata = () => ok(true); v.onerror = () => ok(false); setTimeout(() => ok(v.readyState >= 1), 8000); })`);
    w.destroy();
    must(playable, "the Recordings tab couldn't load the video");
    return shots;
  });

  await step("rename, export and delete", async () => {
    service.library.rename(item.id, "Smoke test – Zoë's checkout");
    must(service.library.get(item.id).title === "Smoke test – Zoë's checkout", "rename didn't stick");
    const dir = join(home, "Exports ü"); mkdirSync(dir, { recursive: true });
    const dest = join(dir, "clip ä.webm");
    service.library.exportVideo(item.id, dest);
    must(statSync(dest).size === statSync(item.video).size, "the exported copy differs");
    // Delete a copy, so the real recording stays for people to look at in CI artifacts.
    const copyId = `${item.id}-copy`;
    cpSync(item.folder, join(service.library.root, copyId), { recursive: true });
    const r = await service.library.remove(copyId);
    must(!existsSync(join(service.library.root, copyId)), "the copy is still there");
    return { exported: dest, deletedToTrash: r.trashed };
  });

  if (env.RUDI_SIM_TEST_TUNNEL) {
    const owned = () => service.connection.readOwned().filter((o) => alive(o.pid));
    const c = service.connection;
    await step("ChatGPT connects with the saved key (stand-in tunnel)", async () => {
      settings.set({ tunnelId: env.RUDI_SIM_SMOKE_TUNNEL_ID || "tunnel_smoke0000test", tunnelClient: process.execPath, use: { ...settings.get().use, chatgpt: true } });
      await c.connect();
      must(await until(() => c.status().state === "connected", 60000), `state: ${JSON.stringify(c.status())}`);
      must(owned().length === 1, `${owned().length} tunnels running`);
      return c.status().detail;
    });
    const base = () => readFileSync(owned()[0].marker, "utf8").trim();
    let n = 100;
    const rpc = (m) => fetch(`${base()}/fake/rpc`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", ...m }) }).then((r) => (r.status === 204 ? null : r.json()));
    await step("ChatGPT starts a recording through the tunnel and the app's launcher", async () => {
      const init = await rpc({ id: ++n, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "openai-mcp", version: "1" } } });
      must(init?.result?.serverInfo, `launcher didn't answer: ${JSON.stringify(init)}`);
      await rpc({ method: "notifications/initialized" });
      const r = await rpc({ id: ++n, method: "tools/call", params: { name: "rudi_start", arguments: { url: site.a } } });
      must(!r.result.isError, JSON.stringify(r).slice(0, 400));
      must(service.hub.status().simulator.ownerKind === "chatgpt", "ChatGPT should own the simulator");
      return "recording";
    });
    await step("Disconnect during the recording saves it and stops the tunnel", async () => {
      const r = await c.disconnect();
      must(r.stopped !== false, `tunnel didn't stop: ${JSON.stringify(r)}`);
      must(owned().length === 0, "a tunnel is still running");
      must(c.status().state === "disconnected" && settings.get().intent === "disconnected", "the disconnect wasn't remembered");
      must(!service.hub.status().simulator.running, "the simulator is still open");
      must(r.recording?.video ? existsSync(r.recording.video) : !r.recordingError, `recording: ${r.recordingError}`);
      return { recording: r.recording?.video || null };
    });
    // ChatGPT's side, as a fresh session through whichever tunnel is running now.
    const chatgptTool = async (name, args = {}) => {
      await rpc({ id: ++n, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "openai-mcp", version: "1" } } });
      await rpc({ method: "notifications/initialized" });
      return (await rpc({ id: ++n, method: "tools/call", params: { name, arguments: args } })).result;
    };
    // Claude Code stays connected locally the whole time.
    const local = mcpClient(process.execPath, [bridgeScript, "--client", "claude", "--hub-only"], bridgeEnv);
    await local.init("claude-code");
    const claudeWorks = async (when) => { const r = await local.tool("rudi_status", {}); must(!r.isError, `Claude stopped working ${when}: ${JSON.stringify(r).slice(0, 300)}`); };
    const chatgptWorks = async (when) => {
      const r = await chatgptTool("rudi_start", { url: site.a });
      must(!r.isError, `ChatGPT can't use its tools ${when}: ${JSON.stringify(r).slice(0, 300)}`);
      must(!(await chatgptTool("rudi_stop", {})).isError, `ChatGPT couldn't stop ${when}`);
    };
    try {
      await step("While disconnected, ChatGPT is refused and Claude still works", async () => {
        const r = await service.hub.call({ id: "chatgpt:smoke", kind: "chatgpt" }, "rudi_status", {});
        must(r.isError, "ChatGPT was let in while disconnected");
        await claudeWorks("while disconnected");
        return "refused; Claude fine";
      });
      await step("Connect again without entering the key, and ChatGPT can use its tools", async () => {
        await c.connect();
        must(await until(() => c.status().state === "connected", 60000), JSON.stringify(c.status()));
        must(owned().length === 1, `${owned().length} tunnels`);
        await chatgptWorks("after Disconnect → Connect");
        await claudeWorks("after Connect");
        return "connected; a ChatGPT tool call worked";
      });
      await step("Restart connection leaves exactly one tunnel", async () => {
        const before = owned()[0].pid;
        await c.restart();
        must(await until(() => c.status().state === "connected", 60000), JSON.stringify(c.status()));
        const now = owned();
        must(now.length === 1 && now[0].pid !== before, `tunnels: ${now.map((o) => o.pid)} (before ${before})`);
        must(!alive(before), "the old tunnel is still running");
        return "one tunnel";
      });
      await step("Disconnect, then Restart connection, and ChatGPT can use its tools", async () => {
        await c.disconnect();
        must(owned().length === 0, "a tunnel is still running after Disconnect");
        await claudeWorks("while disconnected");
        await c.restart();
        must(await until(() => c.status().state === "connected", 60000), JSON.stringify(c.status()));
        must(owned().length === 1, `${owned().length} tunnels`);
        await chatgptWorks("after Disconnect → Restart");
        await claudeWorks("after Restart");
        return "one tunnel; a ChatGPT tool call worked";
      });
    } finally { await local.close(); }
  } else {
    steps.push({ name: "ChatGPT connection with a stand-in tunnel", ok: true, skipped: true, detail: "RUDI_SIM_TEST_TUNNEL not set" });
  }

  await step("Quit stops everything Rudi-Sim started", async () => {
    const tunnels = service.connection.readOwned();
    const report = await service.quit();
    const left = tunnels.filter((o) => alive(o.pid));
    must(!left.length, `tunnels still running: ${left.map((o) => o.pid)}`);
    must(!service.bridge.running(), "the simulator is still running");
    return { connection: report.connection, recording: report.recording?.video || null };
  });

  site?.close();
  await claude?.close(); await gpt?.close();
  result.ok = steps.every((s) => s.ok);
  result.finishedAt = new Date().toISOString();
  save();
  console.log(result.ok ? "Smoke test passed." : "Smoke test FAILED.");
  return result.ok ? 0 : 1;
}
