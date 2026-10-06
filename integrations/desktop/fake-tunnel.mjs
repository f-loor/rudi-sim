#!/usr/bin/env node
// Stands in for OpenAI's tunnel-client in tests. It accepts the same `run`
// arguments Rudi-Sim passes, serves /readyz and /health on 127.0.0.1 and writes
// that address to --health.url-file, like the real one. It starts MCP_COMMAND
// as its child the way tunnel-client does, and POST /fake/rpc forwards one
// JSON-RPC message to that child, so tests can act as ChatGPT.
//
// FAKE_TUNNEL_CONTROL names a JSON file the test edits to change what it
// reports: { "readyz": 200, "controlPlane": { "status": "ok", "reason_code": "" },
// "exit": 3, "health": "missing" }. It prints the key it was given, so tests can
// check that logs hide it.
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const control = () => { try { return JSON.parse(readFileSync(process.env.FAKE_TUNNEL_CONTROL, "utf8")); } catch { return {}; } };
if (control().exit !== undefined) { console.error(`fake tunnel exiting with ${control().exit}`); process.exit(control().exit); }
console.log(`fake tunnel ${args.join(" ")} up with key ${process.env.CONTROL_PLANE_API_KEY || "(none)"} for ${process.env.CONTROL_PLANE_TUNNEL_ID || "(no tunnel id)"}`);

// The MCP child, started once, as tunnel-client does for a stdio binding.
let child = null, pending = new Map();
function words(s) { const out = []; s.replace(/"([^"]*)"|(\S+)/g, (_, q, w) => out.push(q ?? w)); return out; }
if (process.env.MCP_COMMAND) {
  const [cmd, ...rest] = words(process.env.MCP_COMMAND);
  // Like tunnel-client (a Go program), run a Windows .cmd launcher through cmd.exe.
  const viaCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);
  child = viaCmd
    ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${[cmd, ...rest].map((a) => `"${a}"`).join(" ")}"`], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true, windowsVerbatimArguments: true })
    : spawn(cmd, rest, { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  createInterface({ input: child.stdout }).on("line", (line) => {
    try { const m = JSON.parse(line); pending.get(m.id)?.(m); pending.delete(m.id); } catch {}
  });
  child.on("exit", (code) => console.log(`mcp child exited ${code}`));
}

const server = http.createServer((req, res) => {
  const c = control();
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") return res.writeHead(200).end("live");
  if (url.pathname === "/readyz") return res.writeHead(c.readyz ?? 200).end();
  if (url.pathname === "/health") {
    if (c.health === "missing") return res.writeHead(404).end();
    const cp = c.controlPlane ?? { status: "ok", state: "polling" };
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ schema_version: 1, live: true, ready: (c.readyz ?? 200) === 200, runtime: { lifecycle: "running" }, components: { "control-plane": cp } }));
  }
  if (url.pathname === "/fake/rpc" && req.method === "POST" && child) {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", () => {
      const m = JSON.parse(body);
      if (m.id === undefined) { child.stdin.write(JSON.stringify(m) + "\n"); return res.writeHead(204).end(); }
      pending.set(m.id, (reply) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply)));
      child.stdin.write(JSON.stringify(m) + "\n");
    });
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  if (opt("--health.url-file")) writeFileSync(opt("--health.url-file"), `http://127.0.0.1:${server.address().port}`);
});
setInterval(() => { const c = control(); if (c.exit !== undefined) { console.error(`fake tunnel exiting with ${c.exit}`); process.exit(c.exit); } }, 100);
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { child?.kill(); process.exit(0); });
