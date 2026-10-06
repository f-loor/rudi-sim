# Comparing your site before and after a change

## In short

Rudi-Sim can show two versions of your site next to each other on the same phone or tablet: **Before** (how it is now) and **After** (with your change). Every tap and scroll happens on both, so you can spot what your change did.

There are two ways to do it:

- **The easy way:** if both versions are already running (say your live site and your local copy), just give Rudi-Sim the two addresses. Nothing else to set up.
- **The hands-off way:** let Rudi-Sim start both versions for you from your project's code. That needs a small settings file, described below.

## The hands-off way

### 1. Make a settings file

In your project's folder, run:

```
node <rudi-sim folder>/skills/rudi-sim/scripts/preview.mjs init
```

This creates `rudi-sim.project.json`. Open it in any text editor. The parts you'll usually change:

| Setting | What it means | Example |
|---|---|---|
| `name` | a short name for your project | `"my-site"` |
| `original` | the "before" version: a git branch name | `{ "ref": "main" }` |
| `proposed` | the "after" version. `WORKTREE` means "the files in my folder right now", so your edits show up as you save | `{ "ref": "WORKTREE" }` |
| `install` | the command that sets your project up | `"npm install"` |
| `launch` | the command that starts your site. `{port}` is filled in for you | `"npm run dev -- --port {port}"` |
| `port` | which two ports to use | `{ "original": 5101, "proposed": 5102 }` |
| `reset` | optional: a command that puts your demo data back to the same starting point on both sides | `"npm run seed"` |

You can also point a side at a site that's already online, e.g. `"original": { "url": "https://mysite.com" }`.

**Don't put passwords or keys in this file.** If your site needs them, set them on your computer the way you normally do; Rudi-Sim passes them along.

### 2. Give Rudi-Sim permission

```
node <rudi-sim folder>/skills/rudi-sim/scripts/preview.mjs trust rudi-sim.project.json
```

It shows you exactly which commands it will be allowed to run. This is a safety step: Rudi-Sim only ever runs commands from a settings file you approved on your own computer. A website, a chat message or ChatGPT can't make it run anything else. If the file changes, it asks for your OK again.

### 3. Start, compare, stop

```
node <rudi-sim folder>/skills/rudi-sim/scripts/preview.mjs start rudi-sim.project.json --open
```

It starts both versions and opens the Before/After window. Behind the scenes:

- Each version gets its own private copy of your code, so your own folder and branch are left exactly as they were.
- Setup only re-runs when your project's packages actually changed, so later starts are quick.
- A version that's already running is only reused if it's still the same: the same commit (if someone pushed to the branch since, it's restarted on the new commit) and the same settings (start command, setup command, port and so on). Otherwise it says why it's restarting.
- A side that points at your own working folder (rather than a branch) shows your edits as you make them; Rudi-Sim never changes or resets that folder.
- If something else is already using one of the ports, it tells you and doesn't touch it.
- If your site crashes while starting, it shows you the error right away.

When you're done:

```
node <rudi-sim folder>/skills/rudi-sim/scripts/preview.mjs stop rudi-sim.project.json
```

It only stops what Rudi-Sim started, never anything else.

`status` shows what's running, and `reset` puts the demo data back to its starting point on both sides.

With the [Rudi-Sim app](DESKTOP.md) (or ChatGPT through it), you can trust a project file on the **Previews** tab, then just say *"compare my-site before and after on iPhone 17"*.

## For developers

- Copies of each git ref live in `~/.rudi-sim/projects/<name>-<hash>/worktrees/<side>`, with logs and state alongside; nothing is written to your repository.
- The approval is a SHA-256 of the file's contents, stored in `~/.rudi-sim/trusted-projects.json`.
- Commands get `PORT`, `RUDI_SIM_SIDE` (`original`/`proposed`) and `RUDI_SIM_URL`; `{port}`, `{side}`, `{url}` are filled in inside the command text.
- Reuse needs the recorded process (pid + OS start time + command marker), a matching fingerprint of the side's settings (ref, launch, install, env, port, health, repo) and the ref's current SHA. Otherwise the old process is stopped (only if it's provably ours) and the side restarts.
- Reinstall happens when the lockfile hash changes (`--fresh-install` forces it). Stopping kills the whole process tree it started (`taskkill /T` on Windows, the process group elsewhere).
- From the MCP bridge: `rudi_start` with `"project": "<trusted project name>"`.
