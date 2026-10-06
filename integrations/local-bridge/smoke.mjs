import assert from 'node:assert/strict';
import http from 'node:http';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Bridge } from './server.mjs';
const servers=[], clicks=[0,0];
async function fixture(index) {
  const server=http.createServer((req,res)=>{
    if (req.url === '/clicked') { clicks[index]++;res.end('ok');return; }
    res.setHeader('content-type','text/html');
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>${index?'After':'Before'}</title><style>body{background:${index?'#def':'#fed'};min-height:2000px}</style><h1>${index?'After':'Before'}</h1><button id="next" onclick="fetch('/clicked');this.textContent='Clicked'">Next</button>`);
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));servers.push(server);
  return `http://127.0.0.1:${server.address().port}/start`;
}
const bridge=new Bridge({headless:true});
try {
  const before=await fixture(0),after=await fixture(1);
  const start=await bridge.call('rudi_start',{url:before,compareUrl:after,device:'iPhone 17',landscape:true});
  assert.ok(start.content.some(c=>c.type === 'image'),'actual WebKit image returned');
  await assert.rejects(bridge.call('rudi_start',{url:before}),/Stop/);
  const clicked=await bridge.call('rudi_action',{action:'click',args:['#next']});
  assert.notEqual(clicked.isError,true,JSON.stringify(clicked.content.filter(c=>c.type==='text')));
  assert.deepEqual(clicks,[1,1],'action reached both different hosts');
  const rotated=await bridge.call('rudi_action',{action:'rotate'});assert.notEqual(rotated.isError,true);
  const dark=await bridge.call('rudi_action',{action:'theme',args:['dark']});assert.ok(dark.content.some(c=>c.type==='image'));
  const out=bridge.out;
  const stopped=await bridge.call('rudi_stop');assert.notEqual(stopped.isError,true);
  const rec=JSON.parse(stopped.content[0].text).recording;
  assert.ok(rec?.finalized && rec.bytes>0 && rec.folder===out,'stop returns the finished recording: '+stopped.content[0].text);
  const status=JSON.parse((await bridge.call('rudi_status')).content[0].text);
  assert.equal(status.lastRecording.folder,out,'status still finds the recording after the simulator closed');
  // A comparison target that isn't running is an error naming that screen, not ok:true.
  const down=await bridge.call('rudi_start',{url:before,compareUrl:'http://127.0.0.1:9',device:'iPhone 17'});
  assert.equal(down.isError,true,JSON.stringify(down.content.filter(c=>c.type==='text')));
  assert.match(down.content[0].text,/didn't load.*\(After\)/);
  const again=await bridge.call('rudi_action',{action:'retry'});
  assert.equal(again.isError,true,'still down after retry');
  await bridge.call('rudi_stop');
  const videos=(await readdir(out)).filter(f=>f.endsWith('.webm'));
  assert.ok(videos.length); for(const f of videos) assert.ok((await stat(join(out,f))).size>0);
  assert.equal(JSON.parse((await bridge.call('rudi_status')).content[0].text).running,false);
  console.log(`PASS: ${process.env.RUDI_SIM_ENGINE || 'webkit'} comparison, synchronized click on different hosts, rotate, dark screenshot, finalized video returned by stop, unreachable comparison reported. Artifacts: ${out}`);
} finally { await bridge.cleanup();for(const s of servers) await new Promise(ok=>s.close(ok)); }
