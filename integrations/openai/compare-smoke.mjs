#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build, repoRoot } from './build.mjs';
const out = mkdtempSync(join(tmpdir(),'rudi-sim-openai-compare-'));
const pkg = build(join(out,'package'));
const children = [];
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function start(args, ready) {
  const p = spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});
  children.push(p);
  let log='', failure;
  p.stdout.on('data',d=>{log+=d});
  p.stderr.on('data',d=>{log+=d});
  p.on('error',e=>{failure=e});
  for(let i=0;i<120;i++){
    if(failure) throw failure;
    if(log.includes(ready)) return p;
    if(p.exitCode!==null) throw new Error(log||'Process exited before readiness');
    await sleep(250);
  }
  throw new Error('Startup timed out: '+log);
}
function run(script,args){
  const r=spawnSync(process.execPath,[join(pkg.scripts,script),...args],{encoding:'utf8',timeout:120000});
  assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
  return r.stdout;
}
const step=(...args)=>run('walk.mjs',['do',...args]);
const before='http://127.0.0.1:5090', after='http://127.0.0.1:5091';
const devices='iPhone 17, iPhone Duo (open), 1280x800@1, 1920x1080@1';
let session=false;
try{
  await start([join(repoRoot,'integrations/openai/compare-fixture.mjs'),'5090','before'],'READY fixture before');
  await start([join(repoRoot,'integrations/openai/compare-fixture.mjs'),'5091','after'],'READY fixture after');
  // Separate contexts validate device identity/density as well as the paired grid.
  const options=['--device',devices,'--landscape','--themes','light,dark'];
  const b=run('check.mjs',[before,...options,'--out',join(out,'original')]);
  const a=run('check.mjs',[after,...options,'--out',join(out,'proposed')]);
  assert.equal((b.match(/: saved /g)||[]).length,8,b);
  assert.equal((a.match(/: saved /g)||[]).length,8,a);
  assert.match(b,/wider than the screen/,'Fixture should demonstrate the original overflow');
  assert.ok(!/NOT saved|wider than the screen|JS error:|failed:/.test(a),a);
  const pngs=readdirSync(join(out,'original')).filter(x=>x.endsWith('.png'));
  assert.equal(pngs.length,8);
  for(const name of pngs){
    const old=readFileSync(join(out,'original',name));
    const next=readFileSync(join(out,'proposed',name));
    assert.equal(old.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.equal(next.readUInt32BE(16),old.readUInt32BE(16),'Matched screenshot widths');
    assert.ok(!old.equals(next),'Different layout must produce different pixels: '+name);
  }
  await start([join(pkg.scripts,'walk.mjs'),'start',before,'--compare',after,'--device',devices,'--landscape','--headless','--slow','20','--out',join(out,'paired')],'READY:');
  session=true;
  const initial=step('look');
  assert.match(initial,/Page: Original layout/);
  assert.ok(initial.includes('After: '+after+'/'),initial);
  // Side-specific markers prove these are distinct origins, not duplicate original frames.
  assert.match(step('click','Original layout'),/Not found on:.*After/);
  assert.match(step('click','Proposed layout'),/Not found on:.*Before/);
  const click0=step('click','Counter: 0');
  assert.ok(!click0.includes('Not found on'),click0);
  const click1=step('click','Counter: 1');
  assert.ok(!click1.includes('Not found on'),click1);
  step('say','Original fixed-width layout beside the proposed responsive layout.');
  step('scroll','down');
  const navigation=step('goto','/details');
  assert.ok(navigation.includes(before+'/details'),navigation);
  assert.ok(navigation.includes('After: '+after+'/details'),navigation);
  step('rotate','iPhone Duo (open)');
  step('rotate','iPhone Duo (open)');
  step('theme','dark');
  const shot=step('shot','original-proposed-dark');
  const path=shot.match(/^Screenshot: (.+)$/m)?.[1];
  assert.ok(path,shot);
  assert.equal(readFileSync(path).subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const stopped=run('walk.mjs',['stop']);
  session=false;
  assert.match(stopped,/Video:/);
  const videos=readdirSync(join(out,'paired')).filter(x=>x.endsWith('.webm'));
  assert.ok(videos.length>0);
  for(const v of videos) assert.ok(statSync(join(out,'paired',v)).size>1000);
  console.log('PASS: packaged Before/After with different layouts, landscape phones and widescreen, matched independent screenshots, fixed overflow, both origins, synchronized clicks/navigation, rotation, dark mode, paired screenshot and video.\nEvidence: '+out);
}finally{
  if(session) spawnSync(process.execPath,[join(pkg.scripts,'walk.mjs'),'stop'],{timeout:15000,stdio:'ignore'});
  for(const p of children) if(p.exitCode===null) p.kill();
}
