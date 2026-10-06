// Browser actions on one frame (one screen): finding what to tap, listing
// what's tappable, and scrolling until the page actually stops moving.

// A CSS selector, or words on a button, link, tab, label or placeholder.
export async function find(scope, target) {
  if (/^(css=|xpath=|[#.\[]|[a-z0-9-]+[#.\[])/i.test(target)) return firstVisible(scope.locator(target));
  const tries = [
    scope.getByRole("button", { name: target, exact: true }), scope.getByRole("link", { name: target, exact: true }),
    scope.getByRole("tab", { name: target, exact: true }), scope.getByRole("menuitem", { name: target, exact: true }),
    scope.getByText(target, { exact: true }),
    scope.getByRole("button", { name: target }), scope.getByRole("link", { name: target }), scope.getByRole("tab", { name: target }),
    scope.getByLabel(target), scope.getByPlaceholder(target), scope.getByText(target),
  ];
  for (const loc of tries) { const el = await firstVisible(loc); if (el) return el; }
  return null;
}

export async function firstVisible(loc) {
  const n = Math.min(await loc.count().catch(() => 0), 20);
  for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i);
  return null;
}

// Says whether the thing exists but is hidden (often behind a phone menu button).
export async function notFoundMessage(frame, target) {
  const hidden = await frame.getByText(target).count().catch(() => 0) + await frame.getByRole("link", { name: target }).count().catch(() => 0);
  return hidden
    ? `"${target}" is on the page but hidden right now. On small screens it's often behind a menu button; open that first.`
    : `Couldn't find "${target}" on screen.`;
}

export async function tappable(scope) {
  return scope.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll("a[href],button,[role=button],[role=tab],[role=link],[role=menuitem],input,select,textarea,summary,label[for]")) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (!r.width || !r.height || s.visibility === "hidden" || s.display === "none") continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      let t = (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || el.title || "").replace(/\s+/g, " ").trim();
      if (!t) continue;
      const tag = el.tagName === "A" ? "link" : el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? "field" : (el.getAttribute("role") || el.tagName).toLowerCase();
      t = `${t.slice(0, 50)} (${tag})`;
      if (!seen.has(t)) { seen.add(t); out.push(t); }
    }
    return out.slice(0, 40);
  }).catch(() => []);
}

// Scrolls smoothly and resolves once the position has held still for a few
// frames (or after `max` ms), instead of sleeping a fixed time. Returns where
// the page started and ended, and whether it was already at that end.
export function scrollFrame(frame, dir, max = 2000) {
  return frame.evaluate(({ dir, max }) => new Promise((done) => {
    const el = document.scrollingElement || document.documentElement;
    const h = innerHeight, from = el.scrollTop, limit = el.scrollHeight - innerHeight;
    const dy = dir === "up" ? -h * 0.8 : dir === "top" ? -1e7 : dir === "bottom" ? 1e7 : Number(dir) || h * 0.8;
    const atEnd = (dy > 0 && from >= limit - 1) || (dy < 0 && from <= 0);
    window.scrollBy({ top: dy, behavior: "smooth" });
    const start = performance.now();
    let last = from, still = 0, over = false;
    const finish = () => { if (over) return; over = true; done({ from: Math.round(from), to: Math.round(el.scrollTop), atEnd }); };
    // Hidden screens (another one shown at actual size) get no animation frames.
    setTimeout(finish, max);
    const tick = () => {
      const y = el.scrollTop;
      still = Math.abs(y - last) < 0.5 ? still + 1 : 0; last = y;
      // Smooth scrolling can take a frame to begin, so wait for movement or a few still frames.
      if ((still >= 4 && (y !== from || performance.now() - start > 120)) || performance.now() - start > max) finish();
      else if (!over) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), { dir, max });
}
