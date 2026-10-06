# How Rudi-Sim is put together

## In short

There's **one Rudi-Sim**, and a few thin "doors" into it, one for each way people use it:

```
                        ┌──────────────────────────┐
                        │        Rudi-Sim          │
                        │  opens Safari's engine,  │
                        │  shows the devices, taps,│
                        │  scrolls, records video  │
                        └────────────┬─────────────┘
          ┌──────────────────┬───────┴─────────┬──────────────────────┐
     Claude Code         ChatGPT plugin    Connector for any     Rudi-Sim app for
     plugin              (runs on OpenAI's  AI app on your        Windows and Mac
     (runs on your       computers)         computer              (one simulator for
     computer)                                                    Claude Code and
                                                                  ChatGPT, recordings)
```

- **Rudi-Sim itself** does all the real work. Every improvement goes here, and every door gets it at once.
- **The doors** only translate. They tell Claude or ChatGPT which buttons to press; they don't have their own copy of how Rudi-Sim works.
- **GitHub is the one master copy.** Every download is made from it by one command, and an automatic check fails if any download's copy of Rudi-Sim differs from GitHub's even by one byte.

## Which door do I need?

| You use | You need | Can it show sites on my own computer? |
|---|---|---|
| Claude Code | the Claude plugin, or the [Rudi-Sim app](DESKTOP.md) for a Recordings tab and sharing with ChatGPT | Yes, it runs on your computer |
| ChatGPT, for public websites | the ChatGPT plugin | No, it runs on OpenAI's computers |
| ChatGPT, for sites on your own computer, in a window you can watch | the [Rudi-Sim app](DESKTOP.md) and a tunnel (a developer setup for now) | Yes |
| Both | the Rudi-Sim app: both use the same simulator, one at a time | Yes |

## Safety rules built in

- Rudi-Sim only runs commands (like starting your site) from a settings file **you** approved on your own computer. A website or chat message can't make it run anything. See [PREVIEWS.md](PREVIEWS.md).
- Your ChatGPT tunnel key is kept in your computer's password vault, never in a normal file.
- Videos stay on your computer. They're never uploaded to ChatGPT or Claude; screenshots and page text are shared with the assistant you're using.
- Rudi-Sim only stops programs it can prove it started (by process number, start time and command), never anything else on your computer.

## Making the downloads

One command builds every download from GitHub (the installers are built by GitHub's own Windows and Mac computers), and nothing is ever uploaded or published automatically. See [RELEASE.md](RELEASE.md).

## For developers

```
skills/rudi-sim/scripts/      the engine (the only place behaviour lives)
├─ walk.mjs        session CLI: window, steps, recording
├─ viewer.mjs      the Screens / Before-After page
├─ panes.mjs       which screens loaded, and why not
├─ actions.mjs     finding and tapping things, scrolling
├─ recording.mjs   recordings folder, names, session.json
├─ preview.mjs     original/proposed previews from a trusted project file
├─ check.mjs       light/dark screenshots on many devices
└─ lib.mjs, devices.json, setup.mjs, tours/

skills/rudi-sim/SKILL.md            Claude Code skill (calls the CLI)
integrations/openai/                ChatGPT skill + package builder (copies the engine byte for byte)
integrations/local-bridge/          MCP server, 4 tools that drive walk.mjs
integrations/desktop/               shared service for the app and the command-line companion:
                                    hub (one simulator, many assistants), tunnel connection and health,
                                    recordings library, WebKit download, settings, OS secret store
app/                                the Windows/Mac app (Electron shell, UI, self-test, installers)
integrations/release/build.mjs      builds all packages from Git-tracked files, plus installers from CI
```

- The CLI is the contract the skills and bridge rely on: `walk.mjs start / do / stop / tour` and output lines such as `OK:`, `PARTIAL:`, `FAILED:`, `Screens ready:`, `Recording folder:`. Flags are added, not renamed.
- Only `preview.mjs` starts processes, and only from a project file trusted by its SHA-256.
- `integrations/openai/test.mjs` and `integrations/release/test.mjs` fail if a packaged engine file differs from the repository.
- `.claude-plugin/plugin.json` holds the version all packages share; the bridge reports its own adapter version separately.
