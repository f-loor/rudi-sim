// The Rudi-Sim window. It only talks to the app through window.rudi (see
// preload.cjs); everything real happens in the app's service.
"use strict";
const $ = (id) => document.getElementById(id);
const call = (name, arg) => window.rudi.invoke(name, arg);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let S = null;          // latest status from the app
let devices = null;    // { devices, groups }

function toast(text, bad) {
  const t = $("toast"); t.textContent = text; t.className = bad ? "bad" : ""; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), bad ? 8000 : 3500);
}
// Runs a request from a button: disables it, shows errors in plain words.
async function act(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); }
  catch (e) { toast(e.message, true); return undefined; }
  finally { if (btn) btn.disabled = false; }
}
const on = (id, fn) => $(id).addEventListener("click", (e) => { e.preventDefault(); act(e.currentTarget, fn); });
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-link]");
  if (a) { e.preventDefault(); call("openExternal", { url: a.dataset.link }); }
});
// Words that match each system.
const mac = navigator.userAgent.includes("Mac");
for (const el of document.querySelectorAll(".os-tray")) el.textContent = mac ? "menu bar" : "system tray";
for (const el of document.querySelectorAll(".os-store")) el.textContent = mac ? "your Mac's Keychain" : navigator.userAgent.includes("Windows") ? "Windows Credential Manager" : "your computer's password store";

const CONN = {
  "needs-setup": ["Not set up", ""], disconnected: ["Disconnected", ""], starting: ["Starting…", "wait"], connecting: ["Connecting…", "wait"],
  connected: ["Connected", "ok"], reconnecting: ["Reconnecting…", "wait"], "auth-failed": ["Key not accepted", "bad"], failed: ["Stopped retrying", "bad"], stopping: ["Disconnecting…", "wait"],
};
const light = (el, cls) => { el.className = `light ${cls || ""}`; };
const dur = (ms) => (ms == null ? "" : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
const size = (b) => (b == null ? "" : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "");

// ---------------- status ----------------
function render(s) {
  if (!s) return;
  S = s;
  const set = s.settings, c = s.connection, h = s.hub;
  // ChatGPT
  const [label, cls] = CONN[c.state] || [c.state, ""];
  $("chatState").textContent = set.use.chatgpt ? label : "Turned off in Settings";
  $("chatDetail").textContent = set.use.chatgpt ? (c.detail || "") : "";
  light($("chatLight"), set.use.chatgpt ? cls : "");
  const busy = ["starting", "connecting", "stopping"].includes(c.state);
  $("connectBtn").disabled = !set.use.chatgpt || c.state === "connected" || busy || c.state === "needs-setup";
  $("disconnectBtn").disabled = !set.use.chatgpt || ["disconnected", "needs-setup", "stopping"].includes(c.state);
  $("restartBtn").disabled = !set.use.chatgpt || c.state === "needs-setup" || c.state === "stopping";
  // Claude
  const claudes = h.clients.filter((x) => x.kind === "claude" || x.kind === "local");
  $("claudeState").textContent = !set.use.claude ? "Turned off in Settings" : claudes.length ? `Connected (${claudes.length})` : "Not connected right now";
  light($("claudeLight"), set.use.claude && claudes.length ? "ok" : "");
  // Simulator
  const sim = h.simulator;
  $("simState").textContent = sim.running ? `Open${sim.owner ? `, used by ${sim.owner}` : ""}` : "Not open";
  $("simDetail").textContent = sim.running ? [sim.screens, sim.error].filter(Boolean).join(" · ") : "Opens when you or an assistant start a session.";
  light($("simLight"), sim.running ? (sim.ready === false ? "bad" : "ok") : "");
  $("homeStopSim").disabled = !sim.running; $("sStop").disabled = !sim.running;
  $("sActions").hidden = !sim.running;
  // Engine
  renderEngine(s.runtime);
  // Settings page values (only when not being edited)
  if (document.activeElement?.tagName !== "INPUT") fillSettings();
}
function renderEngine(r) {
  if (!r) return;
  const ok = r.ok, text = r.installing ? `Downloading… ${r.percent ?? ""}${r.percent != null ? "%" : ""}` : r.checking ? "Checking…" : ok ? `Ready (Playwright ${r.playwright})` : r.error || "Not downloaded";
  $("engineState").textContent = text; $("tEngine").textContent = text;
  light($("engineLight"), r.installing || r.checking ? "wait" : ok ? "ok" : "bad");
  $("homeEngine").hidden = ok || r.installing || r.checking;
}
window.rudi.on("status", render);
window.rudi.on("runtime", (r) => {
  if (S) S.runtime = r;
  renderEngine(r);
  $("wBar").style.width = `${r.percent ?? (r.ok ? 100 : 0)}%`;
  $("wEngineMsg").textContent = r.installing ? (r.line || "Downloading…") : r.ok ? "Safari's engine is ready." : r.error || "";
});
window.rudi.on("preview-log", (m) => { const l = $("pLog"); l.hidden = false; l.textContent = `${l.textContent}${m}\n`.slice(-6000); l.scrollTop = l.scrollHeight; });

// ---------------- tabs ----------------
for (const b of document.querySelectorAll("nav [data-tab]")) b.addEventListener("click", () => showTab(b.dataset.tab));
function showTab(name) {
  for (const b of document.querySelectorAll("nav [data-tab]")) b.classList.toggle("on", b.dataset.tab === name);
  for (const t of document.querySelectorAll(".tab")) t.hidden = t.id !== `tab-${name}`;
  if (name === "recordings" || name === "home") loadRecordings();
  if (name === "previews" || name === "sim") loadPreviews();
}

// ---------------- home ----------------
on("connectBtn", async () => { await call("connect"); refresh(); });
on("disconnectBtn", async () => {
  const r = await call("disconnect");
  const msg = r.recording?.video ? `Disconnected. ChatGPT's recording was saved.` : r.recordingError ? `Disconnected, but the recording couldn't be finished: ${r.recordingError}` : r.stopped === false ? "The tunnel didn't stop. Try again." : "Disconnected. ChatGPT can't reach this computer until you choose Connect.";
  toast(msg, r.stopped === false || !!r.recordingError); refresh();
});
on("restartBtn", async () => { await call("restartConnection"); refresh(); });
on("homeStopSim", () => stopSim(false));
on("homeEngine", () => installEngine());
on("quitBtn", () => call("quit"));

// ---------------- simulator ----------------
const GROUP_NAMES = { default: "Usual three", iphones: "iPhones", ipads: "iPads", macs: "Macs", all: "All" };
async function loadDevices() {
  devices = await call("devices");
  const chosen = new Set(S.settings.devices || ["iPhone 17"]);
  $("sGroups").innerHTML = Object.entries(devices.groups).map(([g, list]) => `<button class="chip" data-group="${esc(g)}" title="${esc(list.join(", "))}">${esc(GROUP_NAMES[g] || g)}</button>`).join("");
  $("sDevices").innerHTML = devices.devices.map((d) => `<label class="check inline"><input type="checkbox" value="${esc(d.name)}" ${chosen.has(d.name) ? "checked" : ""}> ${esc(d.name)} <small class="muted">${d.width}×${d.height}</small></label>`).join("");
  $("sCustom").value = (S.settings.customSizes || []).join(", ");
  $("sLandscape").checked = !!S.settings.landscape;
}
$("sGroups").addEventListener("click", (e) => {
  const g = e.target.dataset?.group; if (!g) return;
  const names = new Set(devices.groups[g]);
  for (const box of $("sDevices").querySelectorAll("input")) box.checked = names.has(box.value);
});
function chosenDevices() {
  const names = [...$("sDevices").querySelectorAll("input:checked")].map((b) => b.value);
  const custom = $("sCustom").value.split(",").map((x) => x.trim()).filter(Boolean);
  return { names, custom };
}
function parseResult(r) {
  const text = r?.content?.find((c) => c.type === "text")?.text;
  let j = null; try { j = JSON.parse(text); } catch {}
  const img = r?.content?.find((c) => c.type === "image");
  return { json: j, text, image: img ? `data:${img.mimeType};base64,${img.data}` : null, note: r?.content?.filter((c) => c.type === "text").slice(1).map((c) => c.text).join(" "), error: r?.isError };
}
function showResult(r) {
  const p = parseResult(r);
  $("sConflict").hidden = !p.json?.conflict;
  if (p.json?.conflict) { $("sConflictText").textContent = p.json.error; return p; }
  if (p.error) toast(p.json?.error || p.text || "That didn't work.", true);
  const panes = p.json?.panes || [];
  $("sPanes").innerHTML = panes.length ? `<ul class="panes">${panes.map((x) => `<li class="${x.state === "ready" ? "ok" : "bad"}"><b>${esc(x.screen)}</b> ${esc(x.state)}${x.error ? ` · ${esc(x.error)}` : ""}</li>`).join("")}</ul>` : "";
  if (p.image) { $("sShot").src = p.image; $("sShot").hidden = false; }
  if (p.note) toast(p.note);
  return p;
}
on("sStart", async () => {
  const { names, custom } = chosenDevices();
  if (!names.length && !custom.length) throw new Error("Choose at least one screen.");
  const project = $("sProject").value, url = $("sUrl").value.trim(), compare = $("sCompare").value.trim();
  if (!project && !url) throw new Error("Type a website address, or choose a trusted project.");
  await call("saveSettings", { devices: names, customSizes: custom, landscape: $("sLandscape").checked });
  const args = { device: [...names, ...custom].join(", "), theme: $("sTheme").value };
  if (project) args.project = project; else { args.url = url; if (compare) args.compareUrl = compare; }
  if ($("sLandscape").checked) args.landscape = true;
  if ($("sSeed").value !== "") args.seed = Number($("sSeed").value);
  toast("Opening the simulator…");
  showResult(await call("simStart", args));
  refresh();
});
async function stopSim(force) {
  const r = parseResult(await call("simStop", { force }));
  if (r.json?.conflict) { $("sConflict").hidden = false; $("sConflictText").textContent = r.json.error; return; }
  $("sConflict").hidden = true; $("sShot").hidden = true; $("sPanes").innerHTML = "";
  toast(r.json?.recording?.video ? "Stopped. The recording is in Recordings." : r.error ? (r.json?.error || "Couldn't stop cleanly.") : "Stopped.", r.error);
  refresh(); loadRecordings();
}
on("sStop", () => stopSim(false));
on("sForce", () => stopSim(true));
$("sActions").addEventListener("click", (e) => {
  const a = e.target.dataset?.act; if (!a) return;
  act(e.target, async () => showResult(await call("simAction", { action: a })));
});

// ---------------- previews ----------------
async function loadPreviews() {
  const list = await call("previewList").catch(() => []);
  const sel = $("sProject"), cur = sel.value;
  sel.innerHTML = `<option value="">None</option>${list.filter((p) => p.trusted !== false && !p.error).map((p) => `<option>${esc(p.project)}</option>`).join("")}`;
  sel.value = cur;
  $("pList").innerHTML = list.length ? list.map((p) => `<div class="card col"><b>${esc(p.project)}</b>${p.error ? `<small class="bad">${esc(p.error)}</small>` : Object.entries(p.sides || {}).map(([k, v]) => `<small>${k === "original" ? "Original" : "Proposed"}: ${esc(v.url || "-")} · ${v.owned === false ? "already running elsewhere" : v.running ? "running" : "stopped"}${v.sha ? ` · ${esc(v.sha.slice(0, 8))}` : ""}</small>`).join("")}
    <div class="btns"><button data-pstart="${esc(p.project)}">Start</button><button data-pstop="${esc(p.project)}">Stop</button></div></div>`).join("") : `<p class="muted">No trusted projects yet.</p>`;
}
$("pList").addEventListener("click", (e) => {
  const s = e.target.dataset?.pstart, t = e.target.dataset?.pstop;
  if (s) act(e.target, async () => { $("pLog").textContent = ""; await call("previewStart", { name: s }); toast(`${s} is running.`); loadPreviews(); });
  if (t) act(e.target, async () => { await call("previewStop", { name: t }); toast(`${t} stopped.`); loadPreviews(); });
});
on("pChoose", async () => {
  const r = await call("previewChooseFile"); if (!r) return;
  const cmd = (label, c) => (c ? `<div><b>${label}</b><pre class="out">${esc(Array.isArray(c) ? c.join(" ") : c)}</pre></div>` : "");
  $("pReview").hidden = false;
  $("pReview").innerHTML = `<h3>${esc(r.name)}</h3><p class="small">${esc(r.path)}</p>
    <p>If you trust this file, Rudi-Sim will run these commands on this computer to start the two versions:</p>
    ${cmd("Install", r.commands.install)}${cmd("Start", r.commands.launch)}${cmd("Reset", r.commands.reset)}
    <p class="small">Original: ${esc(JSON.stringify(r.original))}<br>Proposed: ${esc(JSON.stringify(r.proposed))}${r.env.length ? `<br>Environment variables: ${esc(r.env.join(", "))}` : ""}</p>
    <button id="pTrust" class="primary">Trust and add</button> <button id="pCancel" class="link">Cancel</button>`;
  $("pTrust").onclick = (e) => act(e.target, async () => { await call("previewTrust", { path: r.path }); $("pReview").hidden = true; toast(`${r.name} is trusted.`); loadPreviews(); });
  $("pCancel").onclick = () => ($("pReview").hidden = true);
});

// ---------------- recordings ----------------
const STATE = { ready: "Ready", recording: "Recording", finalizing: "Saving video…", interrupted: "Interrupted", error: "Problem" };
let recs = [], selected = null;
async function loadRecordings() {
  const r = await call("recordings").catch(() => null); if (!r) return;
  recs = r.items; $("rRoot").textContent = r.root;
  $("rList").innerHTML = recs.length ? recs.map((x) => `<li data-id="${esc(x.id)}" class="${x.id === selected ? "on" : ""}"><b>${esc(x.title)}</b><small><span class="tag ${x.state}">${STATE[x.state] || x.state}</span> ${esc(when(x.startedAt))}${x.durationMs ? ` · ${dur(x.durationMs)}` : ""}</small></li>`).join("") : `<li class="muted">No recordings yet. They appear here when a session stops.</li>`;
  const latest = recs[0];
  $("homeLatest").innerHTML = latest ? `<b>${esc(latest.title)}</b> · ${STATE[latest.state] || latest.state} · ${esc(when(latest.startedAt))} <button id="homeOpenRec">Show</button>` : "No recordings yet.";
  if (latest) $("homeOpenRec").onclick = () => { showTab("recordings"); pick(latest.id); };
  if (selected) pick(selected, true);
}
$("rList").addEventListener("click", (e) => { const li = e.target.closest("li[data-id]"); if (li) pick(li.dataset.id); });
function pick(id, keepVideo) {
  selected = id;
  for (const li of $("rList").querySelectorAll("li")) li.classList.toggle("on", li.dataset.id === id);
  const x = recs.find((r) => r.id === id);
  if (!x) { $("rDetail").textContent = "Choose a recording."; return; }
  const playing = keepVideo && $("rVideo") && !$("rVideo").paused;
  if (playing) return;
  const done = x.state === "ready";
  $("rDetail").className = "detail";
  $("rDetail").innerHTML = `${x.videoUrl && done ? `<video id="rVideo" controls preload="metadata" src="${esc(x.videoUrl)}"></video>` : `<div class="novideo">${esc(x.detail || "No video.")}</div>`}
    <label class="field">Name <input id="rTitle" value="${esc(x.title)}" ${done || x.state === "error" || x.state === "interrupted" ? "" : "disabled"}></label>
    <dl>
      <dt>State</dt><dd>${STATE[x.state] || x.state}${x.detail && done ? "" : x.detail ? ` · ${esc(x.detail)}` : ""}</dd>
      ${x.url ? `<dt>Website</dt><dd>${esc(x.url)}${x.compare ? `<br>compared with ${esc(x.compare)}` : ""}</dd>` : ""}
      ${x.devices?.length ? `<dt>Screens</dt><dd>${esc(x.devices.join(", "))}${x.landscape ? " (landscape)" : ""}</dd>` : ""}
      <dt>Recorded</dt><dd>${esc(when(x.startedAt))}${x.durationMs ? ` · ${dur(x.durationMs)}` : ""}${x.bytes ? ` · ${size(x.bytes)}` : ""}</dd>
      <dt>Folder</dt><dd class="small">${esc(x.folder)}</dd>
    </dl>
    <div class="btns"><button id="rRename">Rename</button><button id="rExport" ${x.video ? "" : "disabled"}>Export video…</button><button id="rShow">Show in folder</button><button id="rDelete" class="danger" ${x.state === "recording" || x.state === "finalizing" ? "disabled" : ""}>Delete…</button></div>`;
  $("rRename").onclick = (e) => act(e.target, async () => { await call("recRename", { id, title: $("rTitle").value }); toast("Renamed."); loadRecordings(); });
  $("rExport").onclick = (e) => act(e.target, async () => { const r = await call("recExport", { id }); if (r) toast("Exported."); });
  $("rShow").onclick = (e) => act(e.target, () => call("recShow", { id }));
  $("rDelete").onclick = (e) => act(e.target, async () => { const r = await call("recDelete", { id }); if (r) { selected = null; $("rDetail").textContent = "Moved to the trash."; loadRecordings(); } });
}
on("rOpenRoot", () => call("recOpenRoot"));

// ---------------- settings ----------------
function fillSettings() {
  const s = S.settings;
  $("tUseClaude").checked = s.use.claude; $("tUseChatgpt").checked = s.use.chatgpt;
  $("tClaudeCmd").textContent = S.claudeCommand; $("wClaudeCmd").textContent = S.claudeCommand;
  $("tTunnelClient").textContent = s.tunnelClient || "Not chosen";
  $("tTunnelId").value = s.tunnelId || "";
  $("tKeyNote").textContent = S.keySaved ? "A key is saved in your computer's password store. Leave the box empty to keep it." : "No key saved yet.";
  $("tFolder").textContent = s.recordingsDir;
  $("tBackground").checked = s.keepRunningInBackground; $("tLogin").checked = s.startAtLogin;
  $("tLoginRow").hidden = $("wLoginRow").hidden = S.platform === "linux";
  $("tVersion").textContent = S.version;
}
const saveSetting = (id, key) => $(id).addEventListener("change", () => act(null, async () => render(await call("saveSettings", { [key]: $(id).checked }))));
saveSetting("tBackground", "keepRunningInBackground");
saveSetting("tLogin", "startAtLogin");
for (const [id, k] of [["tUseClaude", "claude"], ["tUseChatgpt", "chatgpt"]]) $(id).addEventListener("change", () => act(null, async () => render(await call("saveSettings", { use: { ...S.settings.use, [k]: $(id).checked } }))));
async function addClaude(out) {
  const r = await call("addToClaude");
  $(out).hidden = false; $(out).textContent = r.output || (r.ok ? "Added." : "That didn't work.");
}
on("tAddClaude", () => addClaude("tClaudeOut"));
on("wAddClaude", () => addClaude("wClaudeOut"));
const copy = async () => { await navigator.clipboard.writeText(S.claudeCommand); toast("Copied."); };
on("tCopyClaude", copy); on("wCopyClaude", copy);
async function saveTunnel(idBox, keyBox, out) {
  render(await call("saveTunnel", { tunnelId: $(idBox).value.trim(), key: $(keyBox).value }));
  $(keyBox).value = "";
  const r = await call("checkTunnel");
  $(out).hidden = false; $(out).textContent = `${r.ok ? "✓ Setup looks right." : "✗ Something needs fixing."}\n\n${r.output || ""}`.trim();
  return r;
}
on("tSaveTunnel", () => saveTunnel("tTunnelId", "tKey", "tTunnelOut"));
on("tCheck", async () => { const r = await call("checkTunnel"); $("tTunnelOut").hidden = false; $("tTunnelOut").textContent = `${r.ok ? "✓ Setup looks right." : "✗ Something needs fixing."}\n\n${r.output || ""}`.trim(); });
on("tPickTunnel", async () => { await call("chooseTunnelClient"); refresh(); });
on("tForget", async () => { const r = await call("forgetConnection"); if (r.forgotten) toast("Forgot the ChatGPT connection."); refresh(); });
let newFolder = null;
on("tPickFolder", async () => { newFolder = await call("chooseFolder", { title: "Choose where recordings go" }); if (!newFolder) return; $("tNewFolder").textContent = newFolder; $("tMoveAsk").hidden = false; });
const changeFolder = (move) => async () => {
  const r = await call("setRecordingsDir", { dir: newFolder, move });
  $("tMoveAsk").hidden = true;
  toast(move ? `Moved ${r.moved.length} recording${r.moved.length === 1 ? "" : "s"}.${r.skipped.length ? ` ${r.skipped.length} couldn't be moved and stayed where they were.` : ""}` : "New recordings will go to the new folder. The old ones stay where they are.", r.skipped?.length > 0);
  refresh(); loadRecordings();
};
on("tMove", changeFolder(true)); on("tKeep", changeFolder(false));
on("tCancelMove", () => ($("tMoveAsk").hidden = true));
on("tEngineGo", () => installEngine());
on("tUpdates", async () => {
  const r = await call("checkUpdates");
  $("tUpdateOut").textContent = r.error || (r.newer ? `Version ${r.latest} is available.` : r.latest ? "You have the latest version." : r.note || "");
  if (r.newer && r.url) { const a = document.createElement("a"); a.href = "#"; a.dataset.link = r.url; a.textContent = " Download it"; $("tUpdateOut").append(a); }
});
on("tRerunSetup", async () => startWizard());

async function installEngine() {
  const r = await call("runtimeInstall");
  if (!r.ok) toast(r.error || "The download failed.", true); else toast("Safari's engine is ready.");
  return r;
}

// ---------------- first-run guide ----------------
const STEPS = [["use", "Assistants"], ["folder", "Recordings"], ["background", "Running"], ["engine", "Safari's engine"], ["chatgpt", "ChatGPT"], ["test", "Test"]];
let step = 0;
const activeSteps = () => STEPS.filter(([k]) => k !== "chatgpt" || $("wUseChatgpt").checked);
function showStep() {
  const steps = activeSteps(); step = Math.max(0, Math.min(step, steps.length - 1));
  const key = steps[step][0];
  $("wizSteps").innerHTML = steps.map(([k, l], i) => `<li class="${i < step ? "done" : i === step ? "on" : ""}">${esc(l)}</li>`).join("");
  for (const p of document.querySelectorAll(".page")) p.hidden = p.dataset.step !== key;
  $("wBack").disabled = step === 0;
  $("wNext").textContent = step === steps.length - 1 ? "Finish" : "Next";
  $("wSkip").hidden = !["chatgpt", "test", "engine"].includes(key);
  if (key === "folder") $("wFolder").textContent = S.settings.recordingsDir;
  if (key === "chatgpt") { $("wTunnelClient").textContent = S.settings.tunnelClient || "Not chosen"; $("wTunnelId").value = S.settings.tunnelId || ""; }
  if (key === "test") $("wClaudeBox").hidden = !$("wUseClaude").checked;
  if (key === "engine") { const r = S.runtime || {}; $("wEngineMsg").textContent = r.ok ? "Safari's engine is already downloaded." : ""; $("wBar").style.width = r.ok ? "100%" : "0"; $("wEngineGo").textContent = r.ok ? "Download again" : "Download"; }
}
async function leaveStep(key) {
  if (key === "use") {
    if (!$("wUseClaude").checked && !$("wUseChatgpt").checked) throw new Error("Choose at least one assistant.");
    render(await call("saveSettings", { use: { claude: $("wUseClaude").checked, chatgpt: $("wUseChatgpt").checked } }));
  }
  if (key === "background") render(await call("saveSettings", { keepRunningInBackground: $("wBackground").checked, startAtLogin: $("wLogin").checked }));
  if (key === "engine" && !S.runtime?.ok) throw new Error("Download Safari's engine first (or skip and do it later in Settings).");
}
on("wNext", async () => {
  const steps = activeSteps(), key = steps[step][0];
  await leaveStep(key);
  if (step === steps.length - 1) return finishWizard();
  step++; showStep();
});
on("wBack", () => { step--; showStep(); });
on("wSkip", () => { const steps = activeSteps(); if (step === steps.length - 1) return finishWizard(); step++; showStep(); });
on("wPickFolder", async () => {
  const dir = await call("chooseFolder", { title: "Choose where recordings go" }); if (!dir) return;
  await call("setRecordingsDir", { dir, move: false }); await refresh(); $("wFolder").textContent = S.settings.recordingsDir;
});
on("wEngineGo", async () => { $("wEngineMsg").textContent = "Starting the download…"; const r = await installEngine(); if (!r.ok) { $("wEngineMsg").textContent = r.error; $("wEngineGo").textContent = "Try again"; } });
on("wPickTunnel", async () => { const p = await call("chooseTunnelClient"); if (p) $("wTunnelClient").textContent = p; });
on("wSaveTunnel", () => saveTunnel("wTunnelId", "wKey", "wTunnelOut"));
on("wTest", async () => {
  $("wTestOut").innerHTML = `<p class="muted">Opening the simulator…</p>`;
  const r = parseResult(await call("simStart", { url: "https://example.com/", device: "iPhone 17" }));
  if (r.error) { $("wTestOut").innerHTML = `<p class="bad">✗ ${esc(r.json?.error || r.text)}</p>`; return; }
  const ok = (r.json?.panes || []).every((p) => p.state === "ready");
  $("wTestOut").innerHTML = `<p class="${ok ? "ok" : "bad"}">${ok ? "✓ The simulator opened example.com on an iPhone 17 screen." : "✗ The page didn't load. Check your internet connection."}</p>${r.image ? `<img class="shot" src="${r.image}" alt="Screenshot from the test">` : ""}`;
  const stop = parseResult(await call("simStop", {}));
  $("wTestOut").insertAdjacentHTML("beforeend", `<p class="${stop.json?.recording?.video ? "ok" : "muted"}">${stop.json?.recording?.video ? "✓ A test recording was saved. You'll find it under Recordings." : "The simulator closed."}</p>`);
});
async function finishWizard() {
  render(await call("saveSettings", { setupDone: true }));
  $("wizard").hidden = true; $("main").hidden = false; showTab("home");
}
function startWizard() {
  step = 0;
  $("wUseClaude").checked = S.settings.use.claude || !S.settings.use.chatgpt;
  $("wUseChatgpt").checked = S.settings.use.chatgpt;
  $("wBackground").checked = S.settings.keepRunningInBackground; $("wLogin").checked = S.settings.startAtLogin;
  $("main").hidden = true; $("wizard").hidden = false; showStep();
}

// ---------------- start ----------------
async function refresh() { const s = await call("status"); render(s); return s; }
(async function boot() {
  let s = await call("status");
  for (let i = 0; !s && i < 50; i++) { await new Promise((r) => setTimeout(r, 200)); s = await call("status"); }
  render(s);
  call("runtimeCheck").then((r) => { S.runtime = r; renderEngine(r); });
  await loadDevices();
  if (!s.settings.setupDone) startWizard();
  else { $("main").hidden = false; showTab("home"); }
  setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 3000);
})();
