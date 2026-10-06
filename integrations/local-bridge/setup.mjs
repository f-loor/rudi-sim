#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const home = resolve(process.env.RUDI_BRIDGE_HOME || join(homedir(),'.rudi-sim-bridge'));
const result = spawnSync(process.execPath,[fileURLToPath(new URL('../../skills/rudi-sim/scripts/setup.mjs',import.meta.url))],{stdio:'inherit',env:{...process.env,RUDI_SIM_HOME:home}});
process.exit(result.status ?? 1);
