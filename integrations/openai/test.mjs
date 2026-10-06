#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { build, repoRoot } from './build.mjs';

const temporary = mkdtempSync(join(tmpdir(), 'rudi-sim-openai-test-'));
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
}
try {
  const result = build(join(temporary, 'package'));
  const manifest = JSON.parse(readFileSync(join(result.plugin, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'rudi-sim');
  assert.equal(manifest.version, JSON.parse(readFileSync(join(repoRoot, '.claude-plugin/plugin.json'), 'utf8')).version);
  const original = join(repoRoot, 'skills/rudi-sim/scripts');
  const sourceFiles = files(original);
  const bundled = files(result.scripts);
  assert.deepEqual(bundled.map(p => relative(result.scripts, p)).sort(), sourceFiles.map(p => relative(original, p)).sort());
  for (const path of sourceFiles) {
    const name = relative(original, path);
    assert.deepEqual(readFileSync(join(result.scripts, name)), readFileSync(path), `Shared engine changed: ${name}`);
  }
  const skill = readFileSync(join(result.plugin, 'skills/rudi-sim/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: rudi-sim\ndescription: .+\n---\n/);
  assert.ok(!/CLAUDE_SKILL_DIR|run_in_background|\.claude\/skills/.test(skill));
  const market = JSON.parse(readFileSync(join(result.destination, 'marketplace.json'), 'utf8'));
  assert.equal(market.plugins[0].source.path, './rudi-sim');
  assert.throws(() => build(result.destination), /already exists/);
  for (const path of bundled.filter(p => p.endsWith('.mjs'))) {
    const r = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  const run = (...args) => spawnSync(process.execPath, [join(result.scripts, 'check.mjs'), ...args], { encoding: 'utf8' });
  const list = run('--list');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /iPhone SE/);
  const selected = run('https://example.com', '--device', 'iPhone SE, iPad mini, 390x844', '--dry-run');
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(selected.stdout.trim().split('\n').length, 3);
  assert.match(selected.stdout, /Custom 390×844/);
  const invalid = run('https://example.com', '--device', 'iPhone 99', '--dry-run');
  assert.equal(invalid.status, 2);
  console.log(`PASS: self-contained package, ${sourceFiles.length} byte-identical engine files, device selection, invalid input, syntax, and overwrite protection.`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
