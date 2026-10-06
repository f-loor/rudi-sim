#!/usr/bin/env node
// Dependency-free MCP stdio adapter. No public listener or shell execution.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, symlink, readFile, realpath, stat, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { pick } from '../../skills/rudi-sim/scripts/lib.mjs';
import { latestSession, projectFromUrl, recordingsRoot, sessionName } from '../../skills/rudi-sim/scripts/recording.mjs';
import { loadProject, start as startPreviews, trustedProjects } from '../../skills/rudi-sim/scripts/preview.mjs';
import { readHub } from '../desktop/hub.mjs';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const walk = join(root, 'skills/rudi-sim/scripts/walk.mjs');
const str = { type: 'string', minLength: 1, maxLength: 4096 };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const actions = { look: [0,0], click: [1,1], type: [2,2], press: [1,1], scroll: [1,1], back: [0,0], goto: [1,1], say: [1,1], device: [1,1], rotate: [0,1], theme: [1,1], compare: [1,1], menu: [0,0], actual: [0,1], retry: [0,1] };
const loopback = (u) => ['localhost','127.0.0.1','[::1]'].includes(new URL(u).hostname);
export const tools = [
  { name: 'rudi_start', description: 'Open visible WebKit on the computer running this bridge. Give url (and optionally compareUrl for a Before/After comparison whose actions run on both sides), or project: the name of a project the user trusted on that computer, whose original and proposed versions are started and compared. WebKit emulation, not a real iPhone. Use only user-authorized sites. The answer lists every screen (panes) with its state; ok is false unless every screen loaded.', inputSchema: schema({ url: str, compareUrl: str, project: str, name: str, device: str, theme: { enum: ['light','dark'] }, landscape: { type:'boolean' }, seed: { type:'integer', minimum:0, maximum:4294967295 }, ignoreHttpsErrors: { type:'boolean' } }) },
  { name: 'rudi_action', description: 'Drive the visible simulator and return an actual screenshot and tappable elements. Inspect look before clicking. Actions can submit forms; only perform actions authorized by the user. Comparison maps the current path to the second origin. Each answer has panes (which screens loaded) and, for steps, results per screen; partial:true means the step worked on some screens only. Use retry to reload only the screens that failed.', inputSchema: schema({ action: { enum: Object.keys(actions) }, args: { type:'array', items:str, maxItems:2 } }, ['action']) },
  { name: 'rudi_status', description: 'Report whether this bridge owns an active simulator, the trusted projects it can start, and where the last recording was saved.', inputSchema: schema({}), annotations: { readOnlyHint:true } },
  { name: 'rudi_stop', description: 'Close this bridge’s simulator and finalize the local recording. Returns the recording folder, video path and size once the video is finished.', inputSchema: schema({}) }
].map(t => ({ annotations: { readOnlyHint:false, destructiveHint:true, openWorldHint:true }, ...t }));
export function url(value) {
  if (typeof value !== 'string' || value.length > 4096) throw Error('URL required');
  const u = new URL(value);
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password) throw Error('Use an HTTP(S) URL without embedded credentials');
  return u.href;
}
export function validate(name, a = {}) {
  const t = tools.find(t => t.name === name);
  if (!t) throw Error('Unknown tool');
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw Error('Arguments must be an object');
  for (const k of Object.keys(a)) if (!(k in t.inputSchema.properties)) throw Error(`Unknown argument: ${k}`);
  for (const k of t.inputSchema.required) if (!(k in a)) throw Error(`Missing ${k}`);
  for (const [k,v] of Object.entries(a)) {
    const s = t.inputSchema.properties[k];
    if (s.enum && !s.enum.includes(v)) throw Error(`Invalid ${k}`);
    if (s.type === 'string' && (typeof v !== 'string' || !v.length || v.length > 4096 || v.includes('\0'))) throw Error(`Invalid ${k}`);
    if (s.type === 'boolean' && typeof v !== 'boolean') throw Error(`Invalid ${k}`);
    if (s.type === 'integer' && (!Number.isInteger(v) || v < s.minimum || v > s.maximum)) throw Error(`Invalid ${k}`);
    if (s.type === 'array' && (!Array.isArray(v) || v.length > 2 || v.some(x => typeof x !== 'string' || !x.length || x.length > 4096 || x.includes('\0')))) throw Error(`Invalid ${k}`);
  }
  if (name === 'rudi_start') {
    if (a.device) pick(a.device);
    if (!a.url === !a.project) throw Error('Give either url (with optional compareUrl) or project');
    if (a.url) { url(a.url); if (a.compareUrl) url(a.compareUrl); }
    if (a.project && a.compareUrl) throw Error('A project brings its own original and proposed addresses');
    if (a.project && !trustedProjects().some(p => p.name === a.project)) throw Error(`No trusted project named "${a.project}" on this computer. The user trusts one with: node skills/rudi-sim/scripts/preview.mjs trust <file>`);
    if (a.name && !/^[a-z0-9][a-z0-9._ -]{0,59}$/i.test(a.name)) throw Error('Invalid name');
    // Certificate errors may be ignored only for the user's own local servers.
    if (a.ignoreHttpsErrors && (!a.url || ![a.url, a.compareUrl].filter(Boolean).every(loopback))) throw Error('ignoreHttpsErrors is only for localhost addresses');
  }
  if (name === 'rudi_action') {
    const n = (a.args || []).length, [min,max] = actions[a.action];
    if (n < min || n > max) throw Error('Wrong action argument count');
    const v = a.args?.[0];
    if (a.action === 'theme' && !['light','dark'].includes(v)) throw Error('Invalid theme');
    if (a.action === 'compare' && v !== 'off') url(v);
    if (a.action === 'goto' && !v.startsWith('/')) url(v);
    if (a.action === 'scroll' && !/^(down|up|top|bottom|-?\d{1,6})$/.test(v)) throw Error('Invalid scroll');
  }
  return a;
}
export async function imageContent(file, out) {
  const [f,d] = await Promise.all([realpath(file),realpath(out)]);
  const rel = relative(d,f);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !f.endsWith('.png')) throw Error('Screenshot outside session output');
  const s = await stat(f);
  if (!s.isFile() || s.size > 8*1024*1024) throw Error('Screenshot exceeds 8 MiB');
  return { type:'image', mimeType:'image/png', data:(await readFile(f)).toString('base64') };
}
export class Bridge {
  // node/nodeEnv: how to run the engine (the desktop app runs it with its own
  // bundled runtime). recordings: the folder sessions are saved in.
  constructor({ runtimeHome = process.env.RUDI_BRIDGE_HOME || join(homedir(),'.rudi-sim-bridge'), headless = process.env.RUDI_BRIDGE_HEADLESS === '1', node = process.execPath, nodeEnv = {}, recordings = () => recordingsRoot(), extraArgs = [] } = {}) {
    this.runtimeHome = resolve(runtimeHome); this.headless = headless;
    Object.assign(this, { node, nodeEnv, recordings, extraArgs });
    // The desktop companion reads this to show whether a client is connected and the simulator is ready.
    this.statusFile = join(this.runtimeHome, 'status', `bridge-${process.pid}.json`);
    this.info = { pid: process.pid, startedAt: new Date().toISOString(), client: null, initializedAt: null, lastCallAt: null, lastTool: null, simulator: { running: false, ready: null, screens: null, error: null }, output: null, lastRecording: null };
  }
  async writeStatus(patch = {}) {
    Object.assign(this.info, patch);
    try { await mkdir(join(this.runtimeHome, 'status'), { recursive: true }); await writeFile(this.statusFile, JSON.stringify(this.info, null, 2)); } catch {}
  }
  running() { return !!this.child && this.child.exitCode === null && !this.child.signalCode; }
  // What the last answer said about the screens, for the status file.
  noteScreens(r) {
    if (!r || typeof r !== 'object') return;
    const panes = Array.isArray(r.panes) ? r.panes : null;
    this.info.simulator = { running: this.running(), ready: r.ok !== false && (!panes || panes.every(p => p.state === 'ready')), screens: panes ? `${panes.filter(p => p.state === 'ready').length} of ${panes.length} ready` : null, error: r.ok === false ? String(r.error || '').slice(0, 300) : null };
  }
  async request(action,args=[]) {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode) throw Error('No simulator owned by this bridge is running');
    const state = JSON.parse(await readFile(join(this.home,'walk-session.json'),'utf8'));
    if (state.pid !== this.child.pid || !Number.isInteger(state.port)) throw Error('Session ownership mismatch');
    const response = await fetch(`http://127.0.0.1:${state.port}/do`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({action,args}), signal:AbortSignal.timeout(45000) });
    return response.json();
  }
  async call(name,args={}) {
    validate(name,args);
    let r;
    if (name === 'rudi_status') r = { running:this.running(), mode:this.headless?'headless':'visible', output:this.out || null, simulator:this.info.simulator, recordingsFolder:this.recordings(), lastRecording:this.info.lastRecording || latestSession(this.recordings()) || null, trustedProjects:trustedProjects().map(p => p.name) };
    if (name === 'rudi_start') {
      if (this.child && this.child.exitCode === null && !this.child.signalCode) throw Error('Stop the current simulator first');
      await this.cleanup();
      await mkdir(this.runtimeHome,{recursive:true});
      this.home = await mkdtemp(join(this.runtimeHome,'session-'));
      let start = args.url, compare = args.compareUrl, project = args.name;
      if (args.project) {
        // Commands come only from the trusted project file on this computer, never from the chat.
        const cfg = loadProject(trustedProjects().find(p => p.name === args.project).path);
        const sides = await startPreviews(cfg, { say: m => process.stderr.write(`${m}\n`) });
        start = sides.original.url; compare = sides.proposed.url; project = project || cfg.name;
      }
      // Recordings go somewhere a person can find: "Rudi-Sim Recordings/<project>_<date>_<time>".
      this.out = join(this.recordings(), sessionName(project || projectFromUrl(url(start))));
      // Each connection owns isolated state but uses the one-time bridge installation
      // (the desktop app points the engine straight at its own copy of Playwright instead).
      if (!this.nodeEnv.RUDI_SIM_PLAYWRIGHT && !process.env.RUDI_SIM_PLAYWRIGHT) await symlink(join(this.runtimeHome,'node_modules'),join(this.home,'node_modules'),process.platform === 'win32'?'junction':'dir');
      const argv = [walk,'start',url(start),'--out',this.out,'--device',args.device || 'iPhone 17','--theme',args.theme || 'light','--name',project || projectFromUrl(url(start))];
      if (compare) argv.push('--compare',url(compare));
      if (args.seed !== undefined) argv.push('--seed',String(args.seed));
      if (args.ignoreHttpsErrors) argv.push('--ignore-https-errors');
      if (args.landscape) argv.push('--landscape');
      if (this.headless) argv.push('--headless');
      argv.push(...this.extraArgs);
      this.child = spawn(this.node,argv,{ shell:false, env:{...process.env,...this.nodeEnv,RUDI_SIM_HOME:this.home}, stdio:['ignore','pipe','pipe'], windowsHide:true });
      try {
        await new Promise((ok,fail) => {
          let logs = '';
          const timer = setTimeout(() => fail(Error('Simulator startup timed out')),90000);
          const finish = fn => v => { clearTimeout(timer); fn(v); };
          this.child.stdout.on('data',b => { logs = (logs+b).slice(-16000); if (logs.includes('READY:')) finish(ok)(); });
          this.child.stderr.on('data',b => { logs = (logs+b).slice(-16000); try { process.stderr.write(b); } catch {} });
          this.child.once('error',finish(fail));
          this.child.once('exit',finish(() => fail(Error(`Simulator exited before ready: ${logs}`))));
        });
        r = await this.request('look');
      } catch(e) { await this.cleanup(); throw e; }
    }
    if (name === 'rudi_action') r = await this.request(args.action,args.args || []);
    if (name === 'rudi_stop') { r = await this.request('stop'); await this.cleanup(); if (r.recording) this.info.lastRecording = r.recording; }
    if (name !== 'rudi_status') this.noteScreens(r);
    await this.writeStatus({ lastCallAt: new Date().toISOString(), lastTool: name, output: this.out || null, simulator: { ...this.info.simulator, running: this.running() } });
    const content = [{ type:'text', text:JSON.stringify(r) }];
    if (r.screenshot) {
      try { content.push(await imageContent(r.screenshot,this.out)); }
      catch(e) { content.push({type:'text',text:`Screenshot unavailable: ${e.message}`}); }
    }
    return { content, ...(r.ok === false ? {isError:true} : {}) };
  }
  async cleanup() {
    const child = this.child;
    if (child && child.exitCode === null && !child.signalCode) {
      try { await this.request('stop'); } catch { child.kill('SIGTERM'); }
      await new Promise(ok => { const timer = setTimeout(() => { child.kill('SIGKILL'); ok(); },5000); child.once('exit',() => {clearTimeout(timer);ok();}); if (child.exitCode !== null || child.signalCode) {clearTimeout(timer);ok();} });
    }
    this.child = null;
    // Keep screenshots/videos on disk; remove only dependency link.
    if (this.home) await rm(join(this.home,'node_modules'),{force:true}).catch(()=>{});
  }
  removeStatus() { try { rmSync(this.statusFile, { force: true }); } catch {} }
}
// Forwards tool calls to the Rudi-Sim app's hub, so every assistant on this
// computer shares its one simulator, preview manager and recordings library.
export class HubClient {
  constructor({ home, kind = 'local', pid = process.pid }) { Object.assign(this, { home, kind, pid }); this.name = null; this.info = {}; }
  client() { return { id: `${this.kind}:${this.pid}`, kind: this.kind, pid: this.pid, name: this.name }; }
  async post(path, body) {
    const h = readHub(this.home);
    if (!h) throw Error('The Rudi-Sim app isn\'t running on this computer. Open it, then try again.');
    const r = await fetch(`http://127.0.0.1:${h.port}${path}`, { method:'POST', headers:{ 'content-type':'application/json', 'x-rudi-token':h.token }, body:JSON.stringify(body), signal:AbortSignal.timeout(600000) });
    if (!r.ok) throw Error(`The Rudi-Sim app refused the request (${r.status}).`);
    return r.json();
  }
  async writeStatus(patch = {}) {
    if (patch.client !== undefined) { this.name = patch.client; await this.post('/hello', { client: this.client() }).catch(() => {}); }
  }
  async call(name, args = {}) {
    validate(name, args);
    return this.post('/call', { client: this.client(), name, arguments: args });
  }
  async cleanup() { await this.post('/bye', { client: this.client() }).catch(() => {}); }
  removeStatus() {}
}

// Which to use: --hub-only (the app's own launcher) always forwards to the app;
// --standalone never does; otherwise the app is used when it is running.
export function chooseBridge(argv = process.argv.slice(2), env = process.env) {
  const kind = argv.includes('--client') ? argv[argv.indexOf('--client') + 1] : env.RUDI_SIM_CLIENT || 'local';
  const home = resolve(env.RUDI_SIM_DESKTOP_HOME || join(homedir(), '.rudi-sim-desktop'));
  if (argv.includes('--hub-only') || (!argv.includes('--standalone') && readHub(home))) return new HubClient({ home, kind });
  return new Bridge();
}

export async function serve(bridge = chooseBridge()) {
  let initialized = false, ready = false, queue = Promise.resolve();
  const lines = createInterface({input:process.stdin, crlfDelay:Infinity});
  const send = value => process.stdout.write(JSON.stringify(value)+'\n');
  async function handle(line) {
    let m;
    try { m = JSON.parse(line); } catch { send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}}); return; }
    if (!m || Array.isArray(m) || m.jsonrpc !== '2.0' || typeof m.method !== 'string') { send({jsonrpc:'2.0',id:m?.id ?? null,error:{code:-32600,message:'Invalid request'}}); return; }
    if (m.id === undefined) { if (m.method === 'notifications/initialized' && initialized) ready = true; return; }
    try {
      let result;
      if (m.method === 'initialize') {
        // Tunnel discovery and the consuming client may initialize the same
        // stdio process. Repeat negotiation without resetting the owned session.
        initialized = true;
        bridge.writeStatus?.({ initializedAt: new Date().toISOString(), client: m.params?.clientInfo ? `${String(m.params.clientInfo.name || '').slice(0, 60)} ${String(m.params.clientInfo.version || '').slice(0, 20)}`.trim() : null });
        result = { protocolVersion:['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(m.params?.protocolVersion)?m.params.protocolVersion:'2025-06-18', capabilities:{tools:{}}, serverInfo:{name:'rudi-sim-local-bridge',version:'0.2.0'}, instructions:'This server controls WebKit on the bridge host. Inspect screenshots and use only authorized sites/actions. Stop to finalize recording. Local videos are saved on that host.' };
      } else if (m.method === 'ping') result = {};
      else if (!ready) { send({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Initialize first'}}); return; }
      else if (m.method === 'tools/list') result = {tools};
      else if (m.method === 'tools/call') {
        try { result = await bridge.call(m.params?.name,m.params?.arguments); }
        catch(e) { result = {isError:true,content:[{type:'text',text:e.message}]}; }
      } else { send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}}); return; }
      send({jsonrpc:'2.0',id:m.id,result});
    } catch(e) { send({jsonrpc:'2.0',id:m.id,error:{code:-32602,message:e.message}}); }
  }
  lines.on('line',line => { queue = queue.then(() => handle(line)).catch(e => process.stderr.write(e.message+'\n')); });
  lines.on('close',() => { queue.then(() => bridge.cleanup()).finally(() => bridge.removeStatus?.()); });
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => { bridge.cleanup().finally(() => { bridge.removeStatus?.(); process.exit(0); }); });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await serve();
