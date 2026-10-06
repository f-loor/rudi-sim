// Every screen in the Screens window is a "pane": one device on one side
// (Before, the original site, or After, the proposed one). This tracks what each
// pane was asked to load and whether it actually did, so a step can say which
// screens are ready instead of reporting success over a blank one.

// The address the Screens window itself is served from. It is normally the
// Before site, which keeps that site's sign-in cookies first-party. An https
// page may not frame an http one (mixed content), so when Before is https and
// After is http the window is served from the After site instead; Before is
// then framed https-in-http, which browsers allow.
export function viewerOrigin(before, compare) {
  const b = new URL(before);
  if (compare) {
    const c = new URL(compare);
    if (b.protocol === "https:" && c.protocol === "http:") return c.origin;
  }
  return b.origin;
}

// The same page on the After site: the After origin with Before's path.
export function afterTarget(target, compare) {
  const u = new URL(target), c = new URL(compare);
  return c.origin + u.pathname + u.search + u.hash;
}

export function frameName(key, side) { return side === "after" ? `${key}|after` : key; }

// The panes a Screens window should show for these devices.
export function expectedPanes(devices, compare) {
  const sides = compare ? ["before", "after"] : ["before"];
  return devices.flatMap((d) => sides.map((side) => ({ key: d.key, device: d.name, side, frame: frameName(d.key, side) })));
}

export function paneLabel(p, compare) { return compare ? `${p.device} (${p.side === "after" ? "After" : "Before"})` : p.device; }

// Waits, driven by browser events with one bounded deadline, until every pane
// has loaded a page or failed, then reports each one.
//   page: the Screens window; panes: from expectedPanes; requested(p): the url asked for;
//   errors: Map of frame name -> why its page failed (filled in by the request handler).
//   since: Map of frame name -> { frame, n } for screens that were just sent to a new
//     page; they must commit a new page (commits(frame) > n) before they count as loaded,
//     so a screen still showing the old page while the new one downloads isn't "ready".
export async function waitForPanes(page, panes, { requested, errors = new Map(), timeout = 30000, compare = null, since = new Map(), commits = () => 0 } = {}) {
  const deadline = Date.now() + timeout;
  return Promise.all(panes.map((p) => paneStatus(page, p, { requested: requested(p), errors, deadline, compare, timeout, since: since.get(p.frame), commits })));
}

async function paneStatus(page, p, { requested, errors, deadline, compare, timeout, since, commits }) {
  const out = { device: p.device, side: p.side, role: p.side === "after" ? "proposed" : "original", requested, actual: null, state: "loading", error: null };
  const left = () => Math.max(0, deadline - Date.now());
  const find = () => page.frames().find((f) => f.parentFrame() === page.mainFrame() && f.name() === p.frame);
  let frame = find() || await until(page, find, deadline);
  if (!frame) return { ...out, state: "missing", error: "This screen never appeared in the Screens window." };
  if (since && since.frame === frame && commits(frame) <= since.n) {
    const moved = await until(page, () => errors.get(p.frame) || commits(frame) > since.n, deadline);
    if (!moved) return { ...out, actual: frame.url(), state: "loading", error: `The new page hadn't arrived when the ${Math.round(timeout / 1000)}s limit ran out.` };
  }
  // Wait for each step of loading in turn: leave about:blank, finish loading,
  // and get past the redirect hand-off page (a form post that redirects, say).
  for (let hop = 0; hop < 6; hop++) {
    if (frame.isDetached()) { frame = find() || await until(page, find, deadline); if (!frame) break; }
    const err = errors.get(p.frame);
    if (err) return { ...out, actual: frame.url(), state: "error", error: err };
    if (!frame.url() || frame.url() === "about:blank") {
      await until(page, () => { const f = find(); return f && f.url() && f.url() !== "about:blank" && f; }, deadline);
      frame = find() || frame;
      if (!frame.url() || frame.url() === "about:blank") break;
    }
    const loaded = await frame.waitForLoadState("load", { timeout: left() || 1 }).then(() => true, () => false);
    if (!loaded) return { ...out, actual: frame.url(), state: "loading", error: `Still loading when the ${Math.round(timeout / 1000)}s limit ran out.` };
    const flags = await frame.evaluate(() => ({
      hop: !!document.querySelector('meta[name="rudi-sim-redirect"]'),
      failed: document.querySelector('meta[name="rudi-sim-error"]')?.content || null,
      href: location.href,
    })).catch(() => null);
    if (!flags) { if (left()) continue; break; }
    if (flags.failed) return { ...out, actual: flags.href, state: "error", error: flags.failed };
    // The browser's own error page (chrome-error://, about:neterror and the like).
    if (!/^https?:/i.test(flags.href)) return { ...out, actual: flags.href, state: "error", error: "The browser couldn't load this page." };
    if (flags.hop) {
      const was = frame.url();
      await until(page, () => { const f = find(); return f && f.url() !== was && f; }, deadline);
      frame = find() || frame;
      continue;
    }
    return { ...out, actual: flags.href, state: "ready" };
  }
  const err = errors.get(p.frame);
  if (err) return { ...out, state: "error", error: err };
  const url = frame?.url();
  const mixed = compare && requested?.startsWith("http:") && page.url().startsWith("https:");
  return {
    ...out, actual: url && url !== "about:blank" ? url : null, state: "error",
    error: url && url !== "about:blank"
      ? `Didn't finish loading within ${Math.round(timeout / 1000)}s.`
      : `The page never loaded in this screen${mixed ? " (an https page can't show an http one; the browser blocked it as mixed content)" : ""}.`,
  };
}

// Re-checks `test` after every frame event until it returns something truthy
// or the deadline passes. A slow safety tick covers events that never come.
async function until(page, test, deadline) {
  let v = test();
  while (!v && Date.now() < deadline) {
    await new Promise((ok) => {
      const events = ["frameattached", "framenavigated", "framedetached", "load", "domcontentloaded"];
      const done = () => { clearTimeout(t); for (const e of events) page.off(e, done); ok(); };
      const t = setTimeout(done, Math.min(1000, Math.max(1, deadline - Date.now())));
      for (const e of events) page.on(e, done);
    });
    v = test();
  }
  return v || null;
}

// One line naming the panes that aren't ready, or null when all are.
export function notReady(statuses, compare) {
  const bad = statuses.filter((s) => s.state !== "ready");
  if (!bad.length) return null;
  const name = (s) => paneLabel({ device: s.device, side: s.side }, compare);
  return `${bad.length} of ${statuses.length} screen${statuses.length === 1 ? "" : "s"} didn't load: ` +
    bad.map((s) => `${name(s)}: ${s.error || s.state}${s.requested ? ` (${s.requested})` : ""}`).join("; ") +
    (bad.every((s) => s.state === "loading")
      ? ". They may still be loading: send look to check again, or retry to load them again."
      : ". Fix the address or start that server, then send retry (only those screens reload).");
}

// The page shown inside a screen whose page couldn't be fetched, so the user sees
// why in the window instead of a blank screen. The meta tag tells Rudi-Sim too.
export function errorPage(url, reason) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="rudi-sim-error" content="${esc(reason)}"><title>Couldn't load</title>
<style>:root{color-scheme:light dark}body{font:15px/1.4 -apple-system,system-ui,sans-serif;margin:24px;color:CanvasText}code{word-break:break-all}</style>
<h1 style="font-size:18px">Rudi-Sim couldn't load this screen</h1><p>${esc(reason)}</p><p><code>${esc(url)}</code></p>`;
}

// Turns a fetch error into plain words.
export function explainFetchError(e) {
  const m = String(e?.message || e);
  if (/ECONNREFUSED|Connection refused|Could not connect/i.test(m)) return "Nothing answered at that address (connection refused). Is the server running?";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|resolve host|Name or service not known/i.test(m)) return "That address couldn't be found (DNS lookup failed).";
  if (/timed? ?out|ETIMEDOUT/i.test(m)) return "The server took too long to answer.";
  if (/certificate|SSL|TLS|self.signed/i.test(m)) return "The site's security certificate wasn't accepted. For a local https server with its own certificate, start with --ignore-https-errors.";
  return m.split("\n")[0].slice(0, 200);
}
