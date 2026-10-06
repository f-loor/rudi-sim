#!/usr/bin/env node
// One-time setup: installs Playwright and its WebKit (Safari) engine into
// ~/.rudi-sim, outside the skill folder so plugin updates don't wipe it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.RUDI_SIM_HOME || join(homedir(), ".rudi-sim");
const major = Number(process.versions.node.split(".")[0]);
if (major < 18) {
  console.error(`Node ${process.versions.node} is too old. Install Node 20 or newer from https://nodejs.org and try again.`);
  process.exit(1);
}

mkdirSync(home, { recursive: true });
if (!existsSync(join(home, "package.json"))) {
  writeFileSync(join(home, "package.json"), JSON.stringify({ name: "rudi-sim-runtime", private: true }, null, 2));
}

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  // shell:true so Windows finds npm.cmd / npx.cmd
  const r = spawnSync(cmd, args, { cwd: home, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`\nSetup step failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status || 1);
  }
}

if (!existsSync(join(home, "node_modules", "playwright"))) {
  run("npm", ["install", "--no-fund", "--no-audit", "playwright"]);
} else {
  console.log("Playwright already installed.");
}
run("npx", ["playwright", "install", "webkit"]);
console.log(`\nSetup done. Files live in ${home}`);
