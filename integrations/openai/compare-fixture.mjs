#!/usr/bin/env node
// Two controlled pages with the same content/actions and intentionally different CSS.
import http from 'node:http';
const [portText, variant] = process.argv.slice(2);
if (!['before', 'after'].includes(variant)) throw new Error('Expected before or after');
const before = variant === 'before';
const title = before ? 'Original layout' : 'Proposed layout';
const css = before
  ? '.content{width:1100px}.cards{display:flex;gap:24px}.card{width:340px;flex:none}h1{font-size:48px}'
  : '.content{width:100%;max-width:1100px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:16px}.card{min-width:0}h1{font-size:clamp(28px,5vw,48px)}';
http.createServer((req,res) => {
  res.writeHead(200, {'content-type':'text/html; charset=utf-8'});
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>
<style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:20px;font:16px/1.5 system-ui}.content{margin:auto}button,a{margin:4px;padding:12px}.card{padding:20px;border:2px solid #7381a6;border-radius:12px;background:light-dark(#eef3ff,#172137)}${css}</style></head>
<body><main class="content"><h1>Responsive layout review</h1><p>The same content, at the same route, with a proposed responsive layout.</p>
<button onclick="this.textContent='Counter: '+(++window.count)">Counter: 0</button>
<button>${title}</button><a href="/details">Details</a>
<section class="cards"><article class="card"><h2>Mobile</h2><p>Readable content without sideways scrolling.</p></article><article class="card"><h2>Landscape</h2><p>Keep the page usable when the phone is turned.</p></article><article class="card"><h2>Widescreen</h2><p>Keep a comfortable reading width.</p></article></section></main><script>window.count=0</script></body></html>`);
}).listen(Number(portText),'127.0.0.1',()=>console.log('READY fixture '+variant));
