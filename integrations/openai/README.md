# Rudi-Sim for ChatGPT Work and Codex

This integration packages the working Rudi-Sim engine with separate OpenAI instructions. The Claude manifest, skill, scripts, and installation flow remain unchanged. Both packages use the same engine: the builder copies the existing scripts without rewriting them.

## What the first version supports

- WebKit screenshot checks at the requested Apple device sizes, in light and dark mode.
- Headless walkthroughs with screenshots, captions, tap markers, and WebM recordings.
- Original/proposed comparison using the shared Before/After engine, with paired screenshots and recordings.
- Existing device selection and saved tours.

Cloud ChatGPT returns files in the conversation. It does not open a window on the user's computer, provide a live embedded viewer, inherit local browser sign-in, or reach a laptop's localhost automatically. A dev server running in the cloud workspace can be tested there. Hosted preview URLs must be reachable from the execution environment. Later conversations do not automatically inherit a running browser session.

## Build and test

From the repository root:

```sh
node integrations/openai/test.mjs
node integrations/openai/build.mjs --out integrations/openai/build/release
node integrations/openai/smoke.mjs
node integrations/openai/compare-smoke.mjs
```

The output directory must not exist; the builder refuses to overwrite it. The build creates `release/rudi-sim/` as a self-contained plugin and `release/marketplace.json` as a local marketplace. The smoke test requires the original one-time runtime setup (`node skills/rudi-sim/scripts/setup.mjs`) and WebKit's system libraries on Linux. It tests the built package, not the source instructions alone.

GitHub Actions builds an uploadable plugin ZIP and runs WebKit screenshot/walkthrough and comparison smoke tests. The comparison fixture uses visibly different CSS with identical content and controls. It verifies landscape iPhone 17 and open Duo, medium and widescreen sizes, separate device-specific light/dark screenshots, an overflow fix, both preview origins, synchronized clicks/navigation, rotation, and paired screenshot/video output. Comparison evidence is retained as a separate artifact. PRs run the OpenAI job once; push runs are limited to main to avoid duplicate queued checks. The existing three-platform Claude suite runs separately and is unchanged.

## Install and evaluate

For local Codex, add the generated marketplace using `codex plugin marketplace add <absolute-path-to-release>`, then install the plugin using the supported Plugins interface for that client. Local marketplace support varies by surface; this is not a web ChatGPT installation command.

For ChatGPT web, use the supported personal/workspace plugin import flow when available for your account. For public distribution, submit the generated plugin ZIP through OpenAI's skills-only plugin submission path. This repository change does not itself install, publish, or approve the plugin. Packages whose core value requires local execution can require product-specific review. Confirm runtime support and test the imported plugin in a fresh Work conversation before claiming end-to-end compatibility.

OpenAI references:

- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/guides/submit-claude-plugin
- https://developers.openai.com/plugins/deploy/connect-chatgpt

Try these after installation:

1. "Check this preview URL on iPhone SE and iPad mini in light and dark mode."
2. "Record opening the mobile menu and visiting Pricing on an iPhone 16."
3. "Check localhost:3000" when the server runs only on the user's laptop: explain the access boundary rather than claiming a test happened.
4. Ask for a non-website task: the plugin should not activate.

## GitHub updates from PowerShell

Running Claude Code locally does not prevent pushes. GitHub authentication for the local checkout is separate from Claude authentication. Check `git remote -v`, authenticate with `gh auth login` followed by `gh auth setup-git` (if GitHub CLI is installed), create a feature branch, and push it. Do not put a token in a remote URL or plugin file. Never push screenshots or recordings containing private data merely to update the plugin.

The connected ChatGPT GitHub tools can also create branches, commits, and pull requests directly; they do not require your PowerShell terminal to stay open.
