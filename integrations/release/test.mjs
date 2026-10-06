#!/usr/bin/env node
// Checks the release builder: every package is made from tracked files, the
// shared engine is byte-identical in all three, nothing local leaks in, and the
// same commit gives the same bytes. Uses the system `unzip` to prove the
// archives open with an ordinary tool.
// Usage: node --test integrations/release/test.mjs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { build, repoRoot, tracked } from "./build.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const hasUnzip = spawnSync("unzip", ["-v"]).status === 0;

test("builds three packages with the same engine, and nothing untracked", { skip: !hasUnzip && "unzip isn't installed" }, () => {
  const out = mkdtempSync(join(tmpdir(), "rudi-release-"));
  const stray = join(repoRoot, "skills/rudi-sim/scripts/stray-local-file.txt");
  writeFileSync(stray, "not tracked");
  try {
    const r = build({ out, allowDirty: true });
    assert.equal(r.published, false);
    assert.equal(r.packages.length, 3);
    const engine = tracked(["skills/rudi-sim/scripts"]);
    const prefixes = { claude: "rudi-sim/skills/rudi-sim/scripts/", openai: "rudi-sim/skills/rudi-sim/scripts/", cli: "rudi-sim-cli/skills/rudi-sim/scripts/" };
    for (const p of r.packages) {
      const zip = join(r.folder, p.file);
      const t = spawnSync("unzip", ["-tq", zip], { encoding: "utf8" });
      assert.equal(t.status, 0, `${p.file} should open: ${t.stdout}${t.stderr}`);
      const list = spawnSync("unzip", ["-Z1", zip], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
      assert.ok(!list.some((f) => f.includes("stray-local-file")), `${p.file} must not include untracked files`);
      const kind = p.file.split("-")[2];
      for (const f of engine) {
        const inside = prefixes[kind] + f.slice("skills/rudi-sim/scripts/".length);
        const data = spawnSync("unzip", ["-p", zip, inside]).stdout;
        assert.equal(sha(data), sha(readFileSync(join(repoRoot, f))), `${inside} in ${p.file} matches the repository`);
      }
      assert.match(readFileSync(join(r.folder, "SHA256SUMS"), "utf8"), new RegExp(`${p.sha256}  ${p.file}`));
    }
    const cli = spawnSync("unzip", ["-Z1", join(r.folder, r.packages[2].file)], { encoding: "utf8" }).stdout;
    for (const f of ["integrations/desktop/rudi-sim-desktop.mjs", "integrations/desktop/rudi-sim-desktop.sh", "integrations/local-bridge/server.mjs"]) assert.ok(cli.includes(f), `command-line package has ${f}`);
    assert.match(r.signing, /unsigned/);
    assert.equal(r.runtime.electron, JSON.parse(readFileSync(join(repoRoot, "app/package.json"), "utf8")).devDependencies.electron);
    // Installers built elsewhere are added with their platform, checksum and the runtime the self-test saw.
    const inst = join(out, "installers");
    mkdirSync(inst);
    const v = r.version;
    writeFileSync(join(inst, `Rudi-Sim-Setup-${v}-x64.exe`), "exe");
    writeFileSync(join(inst, `Rudi-Sim-${v}-mac-universal.dmg`), "dmg");
    writeFileSync(join(inst, "Rudi-Sim-Setup-0.0.1-x64.exe"), "old version, ignored");
    writeFileSync(join(inst, "windows.smoke.json"), JSON.stringify({ versions: { electron: "44.5.1", node: "24.21.0", playwright: "1.63.0" } }));
    const withApps = build({ out: join(out, "apps"), allowDirty: true, installers: inst });
    assert.deepEqual(withApps.packages.filter((p) => p.platform !== "any").map((p) => [p.platform, p.signed]), [["macos-universal", false], ["windows-x64", false]]);
    assert.equal(withApps.runtime.node, "24.21.0");
    assert.match(readFileSync(join(withApps.folder, "SHA256SUMS"), "utf8"), new RegExp(`Rudi-Sim-Setup-${v.replace(/\./g, "\\.")}-x64\\.exe`));
    // Same commit, same bytes.
    const again = build({ out: join(out, "again"), allowDirty: true });
    assert.deepEqual(again.packages.map((p) => p.sha256), r.packages.map((p) => p.sha256));
  } finally { rmSync(stray, { force: true }); rmSync(out, { recursive: true, force: true }); }
});
