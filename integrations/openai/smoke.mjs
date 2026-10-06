#!/usr/bin/env node
// Exercise the generated package in real WebKit, with no visible desktop.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { build, repoRoot } from './build.mjs';

const output = mkdtempSync(join(tmpdir(), 'rudi-sim-openai-smoke-'));
const packageInfo = build(join(output, 'package'));
const run = (script, args) => {
  const r = spawnSync(process.execPath, [join(packageInfo.scripts, script), ...args], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `${script} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Run the fixture separately because the child command below is synchronous.
const server = spawn(process.execPath, [join(repoRoot, 'test/server.mjs'), '5088'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
let started = false;
try {
  await Promise.race([
    new Promise((resolve, reject) => {
      server.stdout.on('data', data => { if (data.toString().includes('Test site on')) resolve(); });
      server.once('error', reject);
      server.once('exit', code => reject(new Error(`Fixture exited: ${code}`)));
    }),
    delay(10000).then(() => { throw new Error('Fixture startup timed out'); }),
  ]);
  const checks = run('check.mjs', ['localhost:5088', '--device', 'iPhone SE, iPad mini', '--themes', 'light,dark', '--out', join(output, 'checks')]);
  assert.equal((checks.match(/: saved /g) || []).length, 4, checks);
  assert.ok(!checks.includes('NOT saved'), checks);
  const pngs = readdirSync(join(output, 'checks')).filter(name => name.endsWith('.png'));
  assert.equal(pngs.length, 4);
  for (const name of pngs) {
    const image = readFileSync(join(output, 'checks', name));
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
  const overflow = run('check.mjs', ['localhost:5088/wide', '--device', 'iPhone SE', '--themes', 'light', '--out', join(output, 'overflow')]);
  assert.match(overflow, /wider than the screen/);
  const errors = run('check.mjs', ['localhost:5088/errors', '--device', 'iPad mini', '--themes', 'dark', '--out', join(output, 'errors')]);
  assert.match(errors, /undefinedFn/);
  const missing = run('check.mjs', ['localhost:5088/missing', '--device', 'iPhone SE', '--themes', 'light', '--out', join(output, 'missing')]);
  assert.match(missing, /404 for \/missing/);

  browser = spawn(process.execPath, [join(packageInfo.scripts, 'walk.mjs'), 'start', 'localhost:5088', '--device', 'iPhone SE', '--headless', '--single', '--slow', '20', '--out', join(output, 'walk')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  browser.stdout.on('data', d => { log += d; });
  browser.stderr.on('data', d => { log += d; });
  browser.on('error', e => { log += e.message; });
  for (let i = 0; i < 120 && !log.includes('READY:') && browser.exitCode === null; i++) await delay(250);
  assert.match(log, /READY:/, log);
  started = true;
  const step = (...args) => run('walk.mjs', ['do', ...args]);
  assert.match(step('look'), /Page: Home/);
  step('say', 'Open the mobile menu and visit the test form.');
  step('click', '#burger');
  step('click', 'Sign up');
  step('type', 'Email', 'demo@example.com');
  step('type', 'Your name', 'Rudi test');
  step('click', 'Create account');
  assert.match(step('look'), /Thanks/);
  step('device', 'iPad mini');
  step('theme', 'dark');
  const stopped = run('walk.mjs', ['stop']);
  started = false;
  assert.match(stopped, /Video:/);
  const videos = readdirSync(join(output, 'walk')).filter(name => name.endsWith('.webm'));
  assert.ok(videos.length > 0);
  for (const name of videos) assert.ok(statSync(join(output, 'walk', name)).size > 1000);
  console.log(`PASS: WebKit package screenshots, overflow, JS errors, missing page, headless form flow, device/theme switch, and saved video.\nEvidence: ${output}`);
} finally {
  if (started) spawnSync(process.execPath, [join(packageInfo.scripts, 'walk.mjs'), 'stop'], { timeout: 15000, stdio: 'ignore' });
  if (browser && browser.exitCode === null) {
    const exited = once(browser, 'exit');
    browser.kill();
    await Promise.race([exited, delay(3000)]);
  }
  server.kill();
}
