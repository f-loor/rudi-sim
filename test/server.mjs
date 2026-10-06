// A small test site with the awkward cases Rudi-Sim has to handle:
// a phone-only menu, a wide page, a very long page, a form, JS errors,
// a redirect, a slow page, a 404, a new-tab link, a sign-in cookie and a
// second origin. Every page refuses to be framed, like many real sites.
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";

const head = (title) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>${title}</title>`;
const pages = (port) => ({
  "/": head("Home") + `<style>:root{color-scheme:light dark}body{font:16px system-ui;margin:16px}nav a{margin-right:8px}
#burger{display:none}@media(max-width:600px){nav{display:none}nav.open{display:block}#burger{display:inline}}</style>
<button id=burger aria-label="Open menu" onclick="document.querySelector('nav').classList.toggle('open')">☰</button>
<nav><a href="/wide">Wide page</a> <a href="/long">Long page</a> <a href="/form">Sign up</a> <a href="/errors">Errors</a>
<a href="/redirect">Redirect</a> <a href="/slow">Slow</a> <a href="/missing">Broken link</a> <a href="/newtab" target="_blank">New tab</a>
<a href="/login">Log in</a> <a href="http://127.0.0.1:${port}/other">Other site</a></nav>
<h1>Test home</h1><button onclick="this.textContent='Clicked!'">Café ☕ “quotes”</button>
<p><a id=who href="/">Signed in: no</a></p><script>if(document.cookie.includes('js=1'))document.getElementById('who').textContent='Signed in: yes'</script>`,
  "/wide": head("Wide") + "<div style='width:900px;height:50px;background:tomato'>wide</div><a href='/'>Home</a>",
  "/long": head("Long") + Array.from({ length: 1500 }, (_, i) => `<p>Paragraph ${i}</p>`).join("") + "<a href='/'>Bottom home</a>",
  "/form": head("Form") + `<form action=/thanks><label>Email <input name=email></label><input placeholder="Your name" name=n><button>Create account</button></form>`,
  "/thanks": head("Thanks") + "<h1>Thanks!</h1><a href='/'>Home</a>",
  "/errors": head("Errors") + "<script>console.error('boom');undefinedFn()</script><a href='/'>Home</a>",
  "/newtab": head("New tab page") + "<h1>Opened in new tab</h1><a href='/'>Home</a>",
  "/other": head("Other origin") + `<h1>Other site</h1><a href="http://localhost:${port}/">Back home</a>`,
  "/login": head("Login") + "<form method=post action=/dologin><button>Log me in</button></form>",
  // A button only this copy of the site has, for steps that work on one side only.
  "/variant": head("Variant") + `<button>Port ${port}</button> <button onclick="this.textContent='Shared done'">Shared</button>`,
  // Demo data made up in the browser, like many demo modes do. --seed makes it repeat.
  "/random": head("Random") + `<button id=r></button><script>document.getElementById('r').textContent='Value '+Math.random().toFixed(6)</script>`,
});

// tls: { key, cert } serves https instead of http.
export function startServer(port, { tls } = {}) {
  const handler = (req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/redirect") { res.writeHead(302, { Location: "/thanks" }); return res.end(); }
    if (path === "/dologin") {
      res.writeHead(302, { "Set-Cookie": ["sess=1; Path=/; SameSite=Lax; HttpOnly", "js=1; Path=/; SameSite=Lax"], Location: "/" });
      return res.end();
    }
    const send = (body) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" });
      res.end(body);
    };
    if (path === "/slow") return setTimeout(() => send(head("Slow") + "<h1>Finally</h1><a href='/'>Home</a>"), 6000);
    const body = pages(port)[path];
    if (!body) { res.writeHead(404, { "Content-Type": "text/html" }); return res.end("<title>404</title>Not found"); }
    send(body);
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  return new Promise((ok) => server.listen(port, "0.0.0.0", () => ok(server)));
}

if (process.argv[1] && process.argv[1].endsWith("server.mjs")) {
  const port = Number(process.argv[2] || 5077);
  // node server.mjs <port> --tls <key.pem> <cert.pem>
  const t = process.argv.indexOf("--tls");
  const tls = t > 0 ? { key: readFileSync(process.argv[t + 1]), cert: readFileSync(process.argv[t + 2]) } : undefined;
  await startServer(port, { tls });
  console.log(`Test site on ${tls ? "https" : "http"}://localhost:${port}`);
}
