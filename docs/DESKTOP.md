# The Rudi-Sim app for Windows and Mac

## In short

The Rudi-Sim app puts Rudi-Sim on your computer as a normal program. It opens your website in Safari's engine on Apple screen sizes, records what happens, and keeps the videos in one place you can browse. AI assistants drive it:

- **Claude Code** talks to the app directly on your computer. Nothing goes over the internet to reach it.
- **ChatGPT** lives on OpenAI's computers, so it reaches the app through a private line called a tunnel. Setting that up is a developer task for now (see [Connecting ChatGPT](#connecting-chatgpt)).

Both can use the same app, though only one at a time drives the simulator. You can watch the simulator window and click around in it yourself whenever you like.

It's browser emulation: Playwright's build of WebKit, the engine inside Safari, at each device's screen size. It isn't a real iPhone or Apple's iOS Simulator.

## Install it

- **Windows:** run `Rudi-Sim-Setup-<version>-x64.exe`. It installs for your user account only, so you don't need an administrator. You can pick the folder.
- **Mac:** open `Rudi-Sim-<version>-mac-universal.dmg` and drag Rudi-Sim into Applications.

You don't need to install Node.js or anything else first. The app brings its own.

**About the security warning.** These test builds aren't signed yet, so Windows may say "Windows protected your PC" (click **More info**, then **Run anyway**), and a Mac may say the app is from an unidentified developer (right-click the app, choose **Open**, then **Open** again). Signed builds will remove these warnings. That work hasn't been done yet.

## The first time you open it

A short setup guide walks you through six steps. You can go back, and skip the optional ones.

1. **Assistants.** Tick Claude Code, ChatGPT or both.
2. **Recordings.** Choose where videos go. The usual place is a **Rudi-Sim Recordings** folder in your user folder.
3. **Running.** Choose whether Rudi-Sim keeps running in the tray (Windows) or menu bar (Mac) when you close its window, and whether it starts when you sign in.
4. **Safari's engine.** A one-time download of about 70–90 MB, with a progress bar. If it fails, you'll see why in plain words (no internet, a work network blocking it, not enough space) and a **Try again** button.
5. **ChatGPT** (only if you ticked it). See [Connecting ChatGPT](#connecting-chatgpt).
6. **Test.** Rudi-Sim opens example.com on an iPhone 17 screen, shows you the screenshot it took, then closes it and saves a short test video. If you ticked Claude Code, this step also shows the one command that connects Claude Code, with an **Add it for me** button.

You can run the guide again from **Settings** at any time.

## Using it

The app has five tabs.

- **Home** shows four lights: ChatGPT's connection, Claude Code, the simulator, and Safari's engine. Green means working, amber means in progress, red means something needs you, and grey means off or not set up. The ChatGPT card has **Connect**, **Disconnect** and **Restart connection** buttons.
- **Simulator** lets you open a site yourself: type an address (and, if you like, a second one to compare it with), tick the screens you want, then **Open simulator**. **Stop and save recording** closes it and saves the video.
- **Previews** is for comparing two versions of your own project. See [PREVIEWS.md](PREVIEWS.md).
- **Recordings** lists every session, newest first. Click one to play it right there, rename it, export the video, show it in its folder, or delete it.
- **Settings** has everything from the setup guide, plus the version number and **Check for updates**.

To use it from an assistant, just ask. For example, in Claude Code: *"Use Rudi-Sim to open localhost:5000 on an iPhone 17 and scroll to the bottom."*

### Your clicks and the assistant's

When an assistant taps, types or scrolls, it happens on every screen at once. When **you** click in the simulator window, only the screen you click in changes, and the assistant won't know unless you tell it. The Simulator tab says this too.

### When both assistants want it

One assistant at a time drives the simulator. If Claude Code is using it and ChatGPT asks, ChatGPT is told plainly that Claude Code is using it, and Claude's session carries on. If the first assistant has gone away (closed, crashed), the next one is allowed to carry on, and it's told so. On the Simulator tab you'll see who's using it, with a **Stop their session** button if you want to end it yourself.

### Opening, closing and quitting

- Opening Rudi-Sim again while it's running just brings its window forward. There's only ever one copy.
- If **keep running** is on, closing the window leaves Rudi-Sim in the tray or menu bar so assistants can still reach it. Choose **Quit Rudi-Sim** from there (or the bottom of the window) to stop it completely.
- Quitting finishes and saves any recording in progress, closes the ChatGPT connection and stops everything Rudi-Sim started. If a recording can't be saved, it tells you.
- If the app is force-closed (Task Manager, a crash or a power cut), the next start tidies up anything it left running. It only stops programs it can prove it started itself, never anything else.

## Your videos

Each session gets its own folder in your recordings folder, named after the site and the time, like `localhost-5000_2026-10-06_14-30-05`. Inside is the video (`.webm`) and screenshots.

The Recordings tab shows each one's state:

- **Recording** while it's happening, and **Saving video…** for a moment after.
- **Ready** when the video is finished and safe to play or share.
- **Interrupted** if Rudi-Sim was closed before the video was saved. Any screenshots are still there.
- **Problem** if the video is missing (moved or deleted outside Rudi-Sim) or wasn't finished.

Renaming changes the name shown in the app; the folder stays as it is. Deleting moves the whole session folder to your computer's Trash or Recycle Bin, after asking.

**Changing the folder.** In Settings, choose a new folder and Rudi-Sim asks whether to **move** your existing recordings there or **leave** them where they are. A recording that's still being made is never moved.

**Your videos stay on your computer.** They're never uploaded anywhere, including to ChatGPT or Claude. The assistant gets screenshots and page text as it works, and is told where the video was saved.

**Uninstalling keeps your recordings.** Removing the app deletes the program only. Your recordings folder and settings stay until you delete them yourself.

## Connecting Claude Code

Claude Code needs to be told about the app once. The setup guide and Settings show the exact command, and **Add it for me** runs it. It looks like this:

```
claude mcp add --scope user --env ELECTRON_RUN_AS_NODE=1 rudi-sim -- "<the Rudi-Sim program>" "<its bridge file>" --client claude --hub-only
```

Run it in a terminal, or let the app do it. After that, Claude Code can use Rudi-Sim whenever the app is open. The connection stays on your computer.

If you'd rather not install the app, the Claude Code plugin still works on its own (see the main [README](../README.md)). It runs the same engine, but without the app's Recordings tab or sharing with ChatGPT.

## Connecting ChatGPT

**This is a developer setup for now.** ChatGPT reaches your computer through OpenAI's own **tunnel-client** program and a tunnel that belongs to an OpenAI Platform organization. Rudi-Sim can't create tunnels for you, and there's no "sign in with OpenAI" for this yet, so each person needs their own:

1. Open [Tunnels in OpenAI Platform](https://platform.openai.com/settings/organization/tunnels). Your role needs the **Tunnels Read** and **Use** permissions. If you don't see the page, your organization's admin has to turn it on.
2. Create a tunnel and copy its ID (it starts with `tunnel_`).
3. Create a runtime API key for it. Think of it as the tunnel's password.
4. Download **tunnel-client** from the same page. On a Mac, OpenAI also offers it through Homebrew.
5. In Rudi-Sim's setup guide (or Settings), choose tunnel-client, paste the tunnel ID and the key, and press **Save and check**. Rudi-Sim asks tunnel-client to check the setup and shows you its answer.
6. Add the tunnel as a connection in ChatGPT, as OpenAI's tunnel page describes.

**Where the key goes.** Straight into your computer's password store (Windows Credential Manager, or the Mac's Keychain). It's never written to a file, never shown again, and hidden from logs. If your computer has no password store, Rudi-Sim says so and saves nothing.

### Connect, Disconnect, Restart, Forget

- **Disconnect** closes the tunnel, so ChatGPT can't reach your computer, and it **stays disconnected**, even after restarting Rudi-Sim or your computer, until you press **Connect**. If ChatGPT was in the middle of something, Rudi-Sim lets it finish (for up to 20 seconds), then ends ChatGPT's session and saves its recording. Your key, settings and recordings stay, and Claude Code keeps working.
- **Connect** opens the tunnel again with the saved key. You don't type anything. The light only turns green once the tunnel itself reports it's connected to OpenAI, not just because the program started.
- **Restart connection** replaces a stuck tunnel with a fresh one. There's never more than one.
- **Forget connection** (in Settings) deletes the saved key and tunnel ID from this computer, after asking. That's the only thing that deletes them.

If the internet drops or the computer sleeps, the light turns amber (**Reconnecting**) and Rudi-Sim tries again by itself a few times. Nothing ChatGPT asked for is replayed afterwards. If the key stops working (expired or revoked), the light turns red with **Key not accepted**: make a new key and save it in Settings.

## Is it safe?

- Assistants can only use the four Rudi-Sim actions: open a site, act on it (look, tap, type, scroll and so on), check the status, and stop. They can't run other programs.
- Commands that start your own project only come from a project file **you** reviewed and trusted in the app ([PREVIEWS.md](PREVIEWS.md)). A website or chat message can't make Rudi-Sim run anything.
- The connection between the assistants and the app only works on your own computer and needs a secret that changes each time the app starts.
- Your tunnel key is kept only in your computer's password store.

## On Linux, or prefer a terminal?

There's no Linux app yet. The command-line companion does the same job from a terminal (it needs [Node.js](https://nodejs.org)). From the Rudi-Sim folder:

```
node integrations/desktop/rudi-sim-desktop.mjs setup --tunnel-client <path to tunnel-client> --tunnel-id tunnel_YOUR_ID
node integrations/desktop/rudi-sim-desktop.mjs start
```

Then `connect`, `disconnect`, `restart`, `status`, `open` (a status page in your browser), `open-recording`, `open-folder`, `claude-command`, `forget` and `quit`. The app and the companion can't run at the same time; each tells you if the other is running.

## What's been tested

| | Windows | Mac | Linux |
|---|---|---|---|
| Installing into a folder with spaces and non-English letters | ✓ automatic, every change | ✓ automatic (copied from the disk image) | – |
| The installed app's self-test: Safari's engine download (a failed one, then a retry), Claude Code connecting, ChatGPT told the simulator is busy, recording, in-app playback, rename, export, delete | ✓ automatic | ✓ automatic | ✓ by hand, with Chromium instead of WebKit |
| Opening twice, force-close and recovery, quit leaving nothing running | ✓ automatic | ✓ automatic | ✓ by hand |
| Uninstalling keeps recordings | ✓ automatic | – (drag to Trash) | – |
| Connect, Disconnect during a recording, Connect, Restart | ✓ automatic, with a stand-in for tunnel-client | ✓ automatic, with a stand-in | ✓ automatic, with a stand-in |
| Saving the key in the password store | ✓ automatic (real Credential Manager) | ✓ automatic where the runner allows (real Keychain) | ✓ where `secret-tool` exists |
| Sleep and wake, network loss | ✓ automatic, simulated | ✓ automatic, simulated | ✓ automatic, simulated |
| A real ChatGPT conversation through a real tunnel | **still to check by hand** | **still to check by hand** | **still to check by hand** |
| Tray and menu bar, start at sign-in, the native folder picker | **still to check by hand** | **still to check by hand** | – |
| Real sleep and wake on a laptop | **still to check by hand** | **still to check by hand** | – |

"Automatic" means GitHub runs it on every change to the pull request. The stand-in tunnel behaves like OpenAI's tunnel-client (it reports health the same way and runs Rudi-Sim the same way), but it isn't the real thing.

## Try it by hand

About 20 minutes. For each step, note whether it worked and what you saw.

1. Install, open Rudi-Sim and go through the setup guide. The test step shows a screenshot of example.com.
2. Press **Add it for me** for Claude Code, then ask Claude Code to open a site on an iPhone 17. The simulator opens; Home shows Claude Code connected.
3. While Claude is using it, press **Open simulator** on the Simulator tab. You're told Claude Code is using it, with **Stop their session**.
4. Ask Claude to stop. The recording appears in Recordings and plays there.
5. Close the window. Rudi-Sim stays in the tray or menu bar. Open it again from there.
6. If you have a tunnel: set up ChatGPT, press **Connect**, ask ChatGPT to open a site. Then press **Disconnect** while it's recording. The recording is saved, and ChatGPT can't reach the app.
7. Quit Rudi-Sim and open it again. ChatGPT stays disconnected until you press **Connect**, and Connect doesn't ask for the key.
8. Turn Wi-Fi off for 30 seconds, then on. The light goes amber, then green by itself.
9. Put the laptop to sleep for a few minutes and wake it. Same as step 8.
10. Restart your computer. If you chose start at sign-in, Rudi-Sim is in the tray or menu bar.
11. Uninstall. Your recordings folder is still there.

## For developers

- **Why Electron.** The app needs a bundled JavaScript runtime anyway (the engine and Playwright are Node programs), native tray/menu bar, login items, folder pickers and in-app video playback on Windows and macOS, and an installer for each. Electron gives all of that from one codebase, and its own executable doubles as the Node runtime (`ELECTRON_RUN_AS_NODE=1`), so nobody installs Node. Tauri or a native app would need a separately bundled Node. Websites are never shown in Electron's Chromium; the simulator is always Playwright's WebKit, in its own window.
- **Layout.** `app/main.mjs` is the thin shell (window, tray, dialogs, login item, IPC). Everything else is shared with the command-line companion and tests: `integrations/desktop/service.mjs` (one service), `hub.mjs` (one simulator shared by every assistant, with ownership and conflict messages), `connection.mjs` (tunnel lifecycle), `tunnel-health.mjs` (reads tunnel-client's `/readyz` and `/health?details=true`), `library.mjs` (recordings), `runtime.mjs` (WebKit + ffmpeg download), `settings.mjs`, `credentials.mjs`. The UI is `app/ui/` (no remote content; a strict content security policy; the page reaches the app only through `preload.cjs`).
- **How assistants reach it.** The app runs a hub on `127.0.0.1` with a random port and a random token in `hub.json` (mode 0600). Claude Code starts `integrations/local-bridge/server.mjs --client claude --hub-only` with the app's runtime; tunnel-client starts `resources/bin/rudi-sim-mcp(.cmd) --client chatgpt --hub-only`. Both forward the four tools to the hub.
- **Connection states.** needs-setup, disconnected, starting, connecting, connected, reconnecting, auth-failed, failed, stopping. Connected requires tunnel-client's health report (`components["control-plane"].status == "ok"`), not a running process; older tunnel-client versions without `/health` fall back to `/readyz`. A degraded control plane for more than two minutes, or a wake from sleep that doesn't recover within 30 seconds, replaces the tunnel. Up to five quick retries, then **failed**.
- **Process ownership.** Every tunnel, preview and simulator Rudi-Sim starts is recorded with its process number, the operating system's start time for it and a command-line marker. Clean-up stops a process only if all three still match, so a reused process number is left alone. The single-instance and service locks are created atomically (`O_EXCL`), with stale-lock takeover that can't race.
- **Packaging.** `cd app && npm ci && npx electron-builder --win` (or `--mac`). `asar` is off so the engine, Playwright and launchers are plain files. The engine is copied from `skills/rudi-sim/scripts`, `integrations/local-bridge` and `integrations/desktop` into `resources/engine`. Version comes from `app/package.json`, kept equal to `.claude-plugin/plugin.json`.
- **Tests.** `node --test integrations/desktop/test.mjs integrations/desktop/connection.test.mjs` (states, network loss, sleep, auth failure, crash retries, five connect/disconnect cycles, force-close recovery, simultaneous starts, sharing and conflicts, disconnect during an action and a recording, end to end through the stand-in tunnel). `Rudi-Sim --smoke-test=<file.json>` is the installed app's self-test; `node app/test/lifecycle.mjs --app <exe>` checks double start, force-close recovery and quit. CI: `.github/workflows/desktop-app.yml`.
- **Settings and data.** `~/.rudi-sim-desktop/` (or `RUDI_SIM_DESKTOP_HOME`): `settings.json` (never a key), `owned-tunnels.json`, `hub.json`, logs, and `browsers/` for WebKit. Updates: Settings checks GitHub's latest release and links to it; there's no automatic updater yet.
- **Unverified.** How tunnel-client runs a Windows `.cmd` launcher from a path with spaces (Rudi-Sim passes the short 8.3 path when it can); whether tunnel-client passes its environment to the program it starts (the launchers set what they need themselves).
