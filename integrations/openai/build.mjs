#!/usr/bin/env node
// Assemble an independent OpenAI package using byte-identical shared scripts.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../..');

export function build(output) {
  let destination;
  if (output) {
    destination = resolve(output);
    if (existsSync(destination)) throw new Error(`Output already exists: ${destination}. Choose a new directory.`);
    mkdirSync(destination, { recursive: true });
  } else {
    const parent = join(here, 'build');
    mkdirSync(parent, { recursive: true });
    destination = mkdtempSync(join(parent, 'package-'));
  }
  const plugin = join(destination, 'rudi-sim');
  const skill = join(plugin, 'skills/rudi-sim');
  mkdirSync(skill, { recursive: true });
  const claude = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin/plugin.json'), 'utf8'));
  const manifest = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'rudi-sim', version: claude.version,
    description: 'Test websites in WebKit at Apple device sizes and return screenshots and recorded walkthroughs.',
    extensions: { 'com.openai': { interface: {
      displayName: 'Rudi-Sim',
      logo: './assets/rudi-sim-logo.svg',
      composerIcon: './assets/rudi-sim-logo.svg',
    } } },
  };
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  // Center the existing wide vector logo on a square canvas for plugin branding.
  const assets = join(plugin, 'assets');
  mkdirSync(assets, { recursive: true });
  const logo = readFileSync(join(repoRoot, 'media/rudi-sim-logo.svg'), 'utf8')
    .replace(/<metadata>[\\s\\S]*?<\/metadata>/, '')
    .replace(/viewBox="[^"]*"/, 'viewBox="-10 -77.5 400 400"')
    .replace(/width="400" height="245"/, 'width="400" height="400"');
  writeFileSync(join(assets, 'rudi-sim-logo.svg'), logo);
  cpSync(join(here, 'SKILL.md'), join(skill, 'SKILL.md'));
  cpSync(join(repoRoot, 'skills/rudi-sim/scripts'), join(skill, 'scripts'), { recursive: true });
  cpSync(join(repoRoot, 'LICENSE'), join(plugin, 'LICENSE'));
  writeFileSync(join(destination, 'marketplace.json'), JSON.stringify({
    name: 'rudi-sim-openai',
    plugins: [{ name: 'rudi-sim', source: { source: 'local', path: './rudi-sim' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer tools' }],
  }, null, 2) + '\n');
  return { destination, plugin, scripts: join(skill, 'scripts') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--out')) {
    console.error('Usage: node integrations/openai/build.mjs [--out <new-directory>]');
    process.exit(2);
  }
  try { console.log(JSON.stringify(build(args[1]), null, 2)); }
  catch (e) { console.error(e.message); process.exit(1); }
}
