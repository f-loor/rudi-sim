#!/usr/bin/env node
// Builds every Rudi-Sim release package from this repository, and nothing else:
//
//   rudi-sim-claude-<version>.zip    Claude Code plugin (skill + engine)
//   rudi-sim-openai-<version>.zip    ChatGPT / OpenAI plugin (same engine files)
//   rudi-sim-cli-<version>.zip       command-line companion (Linux, or anyone who
//                                    prefers a terminal): same engine files
//   Rudi-Sim-Setup-<v>-x64.exe       Windows installer  } built by electron-builder
//   Rudi-Sim-<v>-mac-universal.dmg   macOS app          } in CI from app/, passed
//                                                       } in with --installers
//   SHA256SUMS, release.json         checksums, and which commit, platform,
//                                    runtime versions and signing status
//
// It never uploads, submits or publishes anything. Packages are put together
// from files tracked in Git, so what ships is exactly what is reviewed.
//
// Usage: node integrations/release/build.mjs [--out dist] [--allow-dirty] [--installers <folder>]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { build as buildOpenAI } from "../openai/build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../..");
const ENGINE = "skills/rudi-sim/scripts";

const git = (...a) => spawnSync("git", a, { cwd: repoRoot, encoding: "utf8" });

// Files Git tracks under these paths (so local runtime state, worktrees, keys
// or recordings that happen to be in the folder can never end up in a package).
export function tracked(paths) {
  const r = git("ls-files", "-z", "--", ...paths);
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  return r.stdout.split("\0").filter(Boolean).filter((f) => existsSync(join(repoRoot, f))).sort();
}

// A small, deterministic zip writer (stored dates are fixed so the same commit
// always gives byte-identical packages). Paths use forward slashes.
export function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = (1 << 5) | 1; // 1980-01-01 00:00
  for (const { name, data, mode = 0o644 } of entries) {
    const n = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(DOS_TIME, 10); h.writeUInt16LE(DOS_DATE, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(packed.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    local.push(h, n, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10); c.writeUInt16LE(DOS_TIME, 12); c.writeUInt16LE(DOS_DATE, 14); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const isExec = (f) => /\.(sh)$/.test(f) || /rudi-sim-desktop\.mjs$/.test(f);
const fromRepo = (files, prefix = "") => files.map((f) => ({ name: prefix + f, data: readFileSync(join(repoRoot, f)), mode: isExec(f) ? 0o755 : 0o644 }));
function walkDir(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkDir(p)); else out.push(p);
  }
  return out.sort();
}

// Which computer an installer is for, from its name.
export function platformOf(name) {
  if (/\.exe$/i.test(name)) return `windows-${/arm64/i.test(name) ? "arm64" : "x64"}`;
  if (/mac/i.test(name) && /\.(dmg|zip)$/i.test(name)) return `macos-${/universal/i.test(name) ? "universal" : /arm64/i.test(name) ? "arm64" : "x64"}`;
  return null;
}

export function build({ out = join(repoRoot, "dist"), allowDirty = false, installers = null } = {}) {
  const dirty = git("status", "--porcelain", "--untracked-files=no").stdout.trim();
  if (dirty && !allowDirty) throw new Error("Commit your changes first: packages are built from what Git has, so they match what was reviewed. (Or pass --allow-dirty for a local try.)");
  const commit = git("rev-parse", "HEAD").stdout.trim();
  const plugin = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin/plugin.json"), "utf8"));
  const version = plugin.version;
  const dest = resolve(out, version);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const engineFiles = tracked([ENGINE]);
  const files = {};

  // Claude Code plugin: the plugin root as the marketplace lists it.
  files[`rudi-sim-claude-${version}.zip`] = zip(fromRepo(tracked([".claude-plugin", "skills", "LICENSE", "README.md"]), "rudi-sim/"));

  // OpenAI package: the existing builder, then zipped.
  const tmp = join(tmpdir(), `rudi-sim-release-${process.pid}-${Date.now()}`);
  try {
    const { destination } = buildOpenAI(tmp);
    // Its builder copies the scripts folder whole; keep only the engine files Git tracks.
    const engineNames = new Set(engineFiles.map((f) => "rudi-sim/" + f));
    const entries = walkDir(destination).map((p) => ({ name: relative(destination, p).split(sep).join("/"), data: readFileSync(p) }))
      .filter((e) => !e.name.startsWith(`rudi-sim/${ENGINE}/`) || engineNames.has(e.name));
    files[`rudi-sim-openai-${version}.zip`] = zip(entries);
  } finally { rmSync(tmp, { recursive: true, force: true }); }

  // Command-line companion: bridge + launcher + engine, keeping the repository
  // layout so their relative imports work unchanged.
  files[`rudi-sim-cli-${version}.zip`] = zip(fromRepo(tracked(["integrations/desktop", "integrations/local-bridge", ENGINE, "LICENSE"]), "rudi-sim-cli/"));

  // Desktop installers built from app/ (same engine files, copied in by electron-builder).
  const app = JSON.parse(readFileSync(join(repoRoot, "app/package.json"), "utf8"));
  const extra = {};
  let runtime = { electron: app.devDependencies.electron, playwright: app.dependencies.playwright, node: null };
  if (installers) {
    for (const f of readdirSync(installers)) {
      // The installed app's self-test results say which runtime it really carries.
      if (/smoke.*\.json$/i.test(f)) { try { const v = JSON.parse(readFileSync(join(installers, f), "utf8")).versions; runtime = { ...runtime, ...Object.fromEntries(Object.entries(v || {}).filter(([, x]) => x)) }; } catch {} continue; }
      const platform = platformOf(f);
      if (!platform || !f.includes(app.version)) continue;
      extra[f] = platform;
    }
  }

  const sums = [];
  const manifest = { name: "rudi-sim", version, commit, dirty: !!dirty, published: false, runtime, signing: "unsigned: Windows code signing and macOS signing/notarization are pending", engine: { path: ENGINE, files: engineFiles.length, sha256: createHash("sha256").update(engineFiles.map((f) => f + "\0" + createHash("sha256").update(readFileSync(join(repoRoot, f))).digest("hex")).join("\n")).digest("hex") }, packages: [] };
  for (const [name, data] of Object.entries(files)) {
    writeFileSync(join(dest, name), data);
    const sha = createHash("sha256").update(data).digest("hex");
    sums.push(`${sha}  ${name}`);
    manifest.packages.push({ file: name, platform: "any", bytes: data.length, sha256: sha });
  }
  for (const [name, platform] of Object.entries(extra)) {
    const data = readFileSync(join(installers, name));
    writeFileSync(join(dest, name), data);
    const sha = createHash("sha256").update(data).digest("hex");
    sums.push(`${sha}  ${name}`);
    manifest.packages.push({ file: name, platform, bytes: data.length, sha256: sha, signed: false });
  }
  writeFileSync(join(dest, "SHA256SUMS"), sums.join("\n") + "\n");
  writeFileSync(join(dest, "release.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { folder: dest, ...manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const a = process.argv.slice(2);
  const out = a.includes("--out") ? resolve(a[a.indexOf("--out") + 1]) : undefined;
  try {
    const r = build({ out, allowDirty: a.includes("--allow-dirty"), installers: a.includes("--installers") ? resolve(a[a.indexOf("--installers") + 1]) : null });
    console.log(`Built Rudi-Sim ${r.version} from ${r.commit.slice(0, 12)}${r.dirty ? " (with uncommitted changes)" : ""} in ${r.folder}`);
    for (const p of r.packages) console.log(`  ${p.file}  ${p.platform}  ${(p.bytes / 1024).toFixed(0)} KB`);
    console.log("Nothing was uploaded or published.");
  } catch (e) { console.error(e.message); process.exit(1); }
}
