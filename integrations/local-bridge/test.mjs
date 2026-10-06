import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { url, validate, imageContent } from './server.mjs';
test('reject unsafe URLs, unknown controls, argument injection and invalid values',() => {
  for (const u of ['file:///etc/passwd','javascript:alert(1)','https://user:password@example.com']) assert.throws(()=>url(u));
  for (const a of [{action:'exec',args:['whoami']},{action:'click',args:[]},{action:'theme',args:['blue']},{action:'scroll',args:['NaN']},{action:'goto',args:['file:///etc/passwd']},{action:'look',shell:true}]) assert.throws(()=>validate('rudi_action',a));
  assert.equal(url('http://localhost:5000'),'http://localhost:5000/');
  assert.deepEqual(validate('rudi_action',{action:'type',args:['Name','$(whoami); & echo secret']}),{action:'type',args:['Name','$(whoami); & echo secret']});
});
test('start needs a url or a trusted project, and certificate errors may be ignored only on localhost',() => {
  assert.throws(()=>validate('rudi_start',{}),/either url/);
  assert.throws(()=>validate('rudi_start',{url:'https://example.com',project:'x'}),/either url/);
  assert.throws(()=>validate('rudi_start',{project:'not-trusted-anywhere-'+process.pid}),/No trusted project/);
  assert.throws(()=>validate('rudi_start',{url:'https://example.com',ignoreHttpsErrors:true}),/localhost/);
  assert.ok(validate('rudi_start',{url:'https://localhost:5001',compareUrl:'http://localhost:5002',ignoreHttpsErrors:true}));
  assert.throws(()=>validate('rudi_start',{url:'http://localhost:1',seed:-1}));
  assert.ok(validate('rudi_action',{action:'retry'}));
});
test('screenshots cannot escape session directory, including symlinks',async() => {
  const dir = await mkdtemp(join(tmpdir(),'rudi-test-'));
  try {
    const out=join(dir,'out'); await mkdir(out); const png=join(out,'shot.png'); await writeFile(png,'fixture');
    assert.equal((await imageContent(png,out)).mimeType,'image/png');
    const outside=join(dir,'other.png'); await writeFile(outside,'private');
    await assert.rejects(imageContent(outside,out));
    // Windows may disallow symlink creation without Developer Mode.
    try { await symlink(outside,join(out,'link.png')); } catch(e) { if (process.platform !== 'win32' || e.code !== 'EPERM') throw e; return; }
    await assert.rejects(imageContent(join(out,'link.png'),out));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('stdio handshake, discovery, validation errors and EOF shutdown',async() => {
  const child=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout}); const waiting=new Map(); let id=0;
  lines.on('line',line=>{const m=JSON.parse(line); waiting.get(m.id)?.(m);waiting.delete(m.id);});
  const rpc=(method,params)=>new Promise(ok=>{const n=++id;waiting.set(n,ok);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');});
  try {
    assert.equal((await rpc('tools/list')).error.code,-32000);
    assert.equal((await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}})).result.protocolVersion,'2025-06-18');
    assert.equal((await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'chatgpt',version:'1'}})).result.protocolVersion,'2025-11-25');
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    assert.equal((await rpc('tools/list')).result.tools.length,4);
    assert.equal((await rpc('initialize',{protocolVersion:'2025-11-25'})).result.protocolVersion,'2025-11-25');
    assert.equal((await rpc('tools/list')).result.tools.length,4);
    assert.equal((await rpc('tools/call',{name:'rudi_action',arguments:{action:'exec'}})).result.isError,true);
    assert.equal(JSON.parse((await rpc('tools/call',{name:'rudi_status'})).result.content[0].text).running,false);
    child.stdin.end();
    await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(Error('EOF did not terminate bridge')),5000); child.once('exit',code=>{clearTimeout(timer);assert.equal(code,0);ok();});});
  } finally { child.kill(); lines.close(); }
});
