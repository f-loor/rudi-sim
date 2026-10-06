// Saves and reads the tunnel's API key with the operating system's own secret
// store: Windows Credential Manager, the macOS keychain, or the Secret Service
// (GNOME Keyring, KWallet) on Linux. The key never goes in a file, on a
// command line, or in a log; it travels to and from the store over a pipe.
import { spawn, spawnSync } from "node:child_process";

const ACCOUNT = "rudi-sim";
const target = (name) => `rudi-sim:${name}`;

function run(cmd, args, { input = null, env } = {}) {
  return new Promise((ok, fail) => {
    const c = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.once("error", fail);
    c.once("exit", (code) => ok({ code, out, err }));
    c.stdin.end(input ?? "");
  });
}
const has = (cmd) => spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore", windowsHide: true }).status === 0;

// Windows: Credential Manager through its own API (CredWrite/CredRead), called from
// PowerShell. The target name is fixed text; the secret comes in on stdin.
const WIN = (op, name) => `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class RudiCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL { public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CredWriteW(ref CREDENTIAL c, UInt32 flags);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CredReadW(string target, UInt32 type, UInt32 flags, out IntPtr c);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CredDeleteW(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static void Write(string t, string u, string s) { byte[] b = Encoding.Unicode.GetBytes(s); IntPtr p = Marshal.AllocHGlobal(b.Length); try { Marshal.Copy(b, 0, p, b.Length); CREDENTIAL c = new CREDENTIAL(); c.Type = 1; c.TargetName = t; c.UserName = u; c.CredentialBlob = p; c.CredentialBlobSize = (UInt32)b.Length; c.Persist = 2; if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(); } finally { Marshal.FreeHGlobal(p); } }
  public static string Read(string t) { IntPtr p; if (!CredReadW(t, 1, 0, out p)) { int e = Marshal.GetLastWin32Error(); if (e == 1168) return null; throw new System.ComponentModel.Win32Exception(e); } try { CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); return c.CredentialBlobSize == 0 ? "" : Marshal.PtrToStringUni(c.CredentialBlob, (int)c.CredentialBlobSize / 2); } finally { CredFree(p); } }
  public static bool Delete(string t) { if (CredDeleteW(t, 1, 0)) return true; int e = Marshal.GetLastWin32Error(); if (e == 1168) return false; throw new System.ComponentModel.Win32Exception(e); }
}
'@
$t='${target(name)}'
${op === "get" ? "$s=[RudiCred]::Read($t); if ($s -eq $null) { exit 3 }; [Console]::Out.Write($s)"
  : op === "set" ? "$s=[Console]::In.ReadToEnd(); [RudiCred]::Write($t,'" + ACCOUNT + "',$s.TrimEnd([char]13,[char]10))"
  : "if (-not [RudiCred]::Delete($t)) { exit 3 }"}`;
const ps = (op, name, input) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WIN(op, name), "utf16le").toString("base64")], { input });

const checkName = (name) => { if (!/^[a-z0-9:._-]{1,80}$/i.test(name)) throw new Error("Credential names are letters, numbers and : . _ -"); };
// The key itself must be one line of printable text (it is passed through a pipe and,
// on macOS, inside a quoted keychain command).
const checkSecret = (s) => { if (typeof s !== "string" || !s.length || s.length > 4096 || /[\0-\x1f\x7f"\\]/.test(s)) throw new Error("That doesn't look like an API key (one line, no quotes or backslashes)."); };

export const providers = {
  windows: {
    label: "Windows Credential Manager",
    available: () => process.platform === "win32",
    async get(name) { const r = await ps("get", name); if (r.code === 3) return null; if (r.code) throw new Error(`Credential Manager: ${r.err.trim().split("\n")[0]}`); return r.out; },
    async set(name, secret) { const r = await ps("set", name, secret); if (r.code) throw new Error(`Credential Manager: ${r.err.trim().split("\n")[0]}`); },
    async delete(name) { const r = await ps("delete", name); if (r.code && r.code !== 3) throw new Error(`Credential Manager: ${r.err.trim().split("\n")[0]}`); return r.code === 0; },
  },
  macos: {
    label: "macOS keychain",
    available: () => process.platform === "darwin" && has("security"),
    async get(name) { const r = await run("security", ["find-generic-password", "-a", ACCOUNT, "-s", target(name), "-w"]); return r.code === 0 ? r.out.replace(/\n$/, "") : null; },
    // `security -i` reads the command from stdin, so the key isn't visible in the process list.
    async set(name, secret) { const r = await run("security", ["-i"], { input: `add-generic-password -U -a ${ACCOUNT} -s ${target(name)} -l "Rudi-Sim tunnel key" -w "${secret}"\n` }); if (r.code || /error/i.test(r.err)) throw new Error(`Keychain: ${(r.err || r.out).trim().split("\n")[0]}`); },
    async delete(name) { const r = await run("security", ["delete-generic-password", "-a", ACCOUNT, "-s", target(name)]); return r.code === 0; },
  },
  linux: {
    label: "Secret Service (GNOME Keyring or KWallet)",
    available: () => process.platform === "linux" && has("secret-tool"),
    async get(name) { const r = await run("secret-tool", ["lookup", "service", "rudi-sim", "account", name]); return r.code === 0 && r.out ? r.out.replace(/\n$/, "") : null; },
    async set(name, secret) { const r = await run("secret-tool", ["store", "--label=Rudi-Sim tunnel key", "service", "rudi-sim", "account", name], { input: secret }); if (r.code) throw new Error(`Secret Service: ${r.err.trim().split("\n")[0] || "secret-tool failed"}`); },
    async delete(name) { const r = await run("secret-tool", ["clear", "service", "rudi-sim", "account", name]); return r.code === 0; },
  },
};

// The store for this computer, or null when none is available. There is no
// plain-file fallback on purpose.
export function systemProvider() {
  return Object.values(providers).find((p) => p.available()) || null;
}

// Wraps a provider with the name and secret checks every caller needs.
export function store(provider = systemProvider()) {
  if (!provider) return null;
  return {
    label: provider.label,
    get: async (name) => { checkName(name); return provider.get(name); },
    set: async (name, secret) => { checkName(name); checkSecret(secret); return provider.set(name, secret); },
    delete: async (name) => { checkName(name); return provider.delete(name); },
  };
}

// For tests: a store that forgets everything when the process ends.
export function memoryProvider() {
  const m = new Map();
  return { label: "memory (tests only)", available: () => true, get: async (n) => m.get(n) ?? null, set: async (n, s) => { m.set(n, s); }, delete: async (n) => m.delete(n) };
}
