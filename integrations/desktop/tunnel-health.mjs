// Turns what OpenAI's tunnel-client reports about itself into one connection
// state. tunnel-client serves /readyz and /health?details=true on 127.0.0.1
// (started with --health.listen-addr 127.0.0.1:0 --health.url-file <file>).
// A running process is never taken as proof of a connection on its own.
//
// Documented by tunnel-client (docs/health.md): /readyz is 200 when ready and
// 503 while gated; /health?details=true has `ready`, `runtime.lifecycle`, and a
// `components` map whose `control-plane` entry has `status` (ok, degraded,
// unknown, disabled), `state` and an optional `reason_code`. Older runtimes
// answer 404 for /health, so the readiness probe alone is used there.

const AUTH = /auth|unauthori[sz]ed|forbidden|permission|denied|invalid[_-]?(api[_-]?)?key|revoked|expired|401|403/i;

// Inputs: { reachable, readyz (HTTP status or null), health (parsed JSON or null) }
// Output: { state, detail, auth, evidence }
//   state: "connecting" (process up, not yet confirmed), "connected",
//          "reconnecting" (was or should be connected, isn't now), "auth-failed"
export function classify({ reachable, readyz = null, health = null }) {
  if (!reachable) return { state: "connecting", detail: "Waiting for tunnel-client to report its status.", auth: false, evidence: "no-health-answer" };
  const cp = health?.components?.["control-plane"] || null;
  const reason = cp?.reason_code || "";
  if (cp && AUTH.test(reason)) return { state: "auth-failed", detail: `OpenAI didn't accept the tunnel key (${reason}).`, auth: true, evidence: "control-plane" };
  if (health?.runtime?.lifecycle === "draining") return { state: "reconnecting", detail: "tunnel-client is shutting down.", auth: false, evidence: "runtime" };
  if (readyz !== 200 || health?.ready === false) {
    return { state: "connecting", detail: reason ? `Not ready yet (${reason}).` : "Not ready yet.", auth: false, evidence: "readyz" };
  }
  if (!cp) {
    // Ready by the runtime's own decision, but no detail about the link to OpenAI.
    return { state: "connected", detail: "tunnel-client reports ready (this version doesn't report connection details).", auth: false, evidence: "readyz-only" };
  }
  if (cp.status === "ok") return { state: "connected", detail: "Connected to OpenAI's tunnel service.", auth: false, evidence: "control-plane" };
  return { state: "reconnecting", detail: `The link to OpenAI is ${cp.status || "unknown"}${reason ? ` (${reason})` : ""}; tunnel-client is retrying.`, auth: false, evidence: "control-plane" };
}

// Reads one snapshot. `base` is the URL tunnel-client wrote to its url file.
export async function probe(base, { timeoutMs = 3000 } = {}) {
  if (!base) return { reachable: false };
  const root = base.replace(/\/+(healthz|readyz)?\/*$/, "");
  const get = (path) => fetch(root + path, { signal: AbortSignal.timeout(timeoutMs) });
  let readyz;
  try { readyz = (await get("/readyz")).status; } catch { return { reachable: false }; }
  let health = null;
  try { const r = await get("/health?details=true"); if (r.ok) health = await r.json(); } catch {}
  return { reachable: true, readyz, health };
}
