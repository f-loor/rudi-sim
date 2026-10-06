# Getting Rudi-Sim ready to share

## In short

Everything Rudi-Sim gives people is made from what's on GitHub, by one command. Nothing gets sent anywhere or listed in any store until a person decides to do it by hand.

It makes these downloads:

- **For Claude Code:** the Claude plugin.
- **For ChatGPT:** the ChatGPT plugin.
- **For Windows:** the Rudi-Sim app installer ([how it works](DESKTOP.md)).
- **For Mac:** the Rudi-Sim app, as a disk image and a zip.
- **For Linux or the terminal:** the command-line companion.

All of them contain the exact same Rudi-Sim inside, so a fix made once reaches everyone.

## Make the downloads

1. Make sure the changes are merged on GitHub.
2. In the Rudi-Sim folder, run `node integrations/release/build.mjs`.
3. The files appear in a `dist` folder, with a version number. There's also a list of fingerprints (`SHA256SUMS`) so anyone can check a download wasn't changed, and `release.json`, which says which commit made them, which computers each one is for, which runtime versions are inside, and that they aren't signed yet.

The Windows and Mac apps have to be built on Windows and Mac computers, so GitHub builds them when a pull request changes the app, its runtime dependencies, or the installer workflow, installs them, tests them, and puts everything together. Open the pull request's **Checks** tab, then **Desktop app**, and download **rudi-sim-all-packages** to get exactly what would ship.

## Sharing them (later, by hand)

| Where | How | Done yet? |
|---|---|---|
| Claude Code | People can already install it straight from GitHub. Getting listed in a public plugin directory is a separate application. | Installable from GitHub; not listed anywhere |
| ChatGPT | Upload the ChatGPT plugin download; a public listing goes through OpenAI's review. | Not submitted |
| Windows and Mac app | Attach the installers to a GitHub Release page. The app's **Check for updates** looks there. | Not published |
| Command-line companion | Attach its zip to the same Release page. | Not published |

## Still to sort out before sharing publicly

- **Try it by hand** on a real Windows PC and a Mac, with a real ChatGPT connection ([checklist](DESKTOP.md#try-it-by-hand)).
- **Signing.** Windows and macOS warn that the app is from an unknown publisher. Removing that needs a Windows code-signing certificate and an Apple Developer account (for signing and notarization), which cost money. The builds are ready for it; only the certificates and settings are missing.
- **Who can use the ChatGPT connection.** Each person needs their own OpenAI Platform tunnel, which needs organization permissions many people won't have. There's no simple sign-in for it yet. Any public listing should say so.
- **Privacy note.** Screenshots and page text go to the AI assistant; videos stay on the person's computer. Say this on any listing.

## For developers

- The version shared by all packages is in `.claude-plugin/plugin.json`.
- The version shared by the app is in `app/package.json`; keep it equal to the plugin's.
- The builder refuses uncommitted changes (`--allow-dirty` for a local try), includes only Git-tracked files, and produces byte-identical zips for the same commit. `--installers <folder>` adds installers built elsewhere (CI), with their platform, and reads runtime versions from the installed app's self-test results. `release.json` records the commit, an engine fingerprint, each package's platform and checksum, Electron/Node/Playwright versions, the signing status and `"published": false`.
- `node --test integrations/release/test.mjs` checks every package carries the repository's engine files unchanged and nothing untracked.
