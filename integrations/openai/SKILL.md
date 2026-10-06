---
name: rudi-sim
description: Test a website in WebKit at Apple device sizes, inspect light and dark screenshots, and record interactive walkthroughs. Use for iPhone, iPad, Mac, Safari, responsive layout checks, recorded website demos, or original/proposed layout comparisons.
---

# Rudi-Sim for ChatGPT Work and Codex

Use the bundled Node scripts to render the actual target page with Playwright WebKit. This is browser emulation, not Apple's iOS Simulator or a real iPhone. Do not claim coverage of the iOS keyboard, browser toolbar, native apps, or physical hardware. Do not substitute generated pictures or Chrome screenshots for WebKit results.

Resolve `scripts/` relative to this installed SKILL.md; use its absolute path in commands. Do not use Claude environment variables or a hardcoded home-directory skill path. Below, `<scripts>` is that absolute directory and `<output>` is a writable task output directory outside the installed plugin.

## Runtime and access

- Check Node 18+ and WebKit availability. When missing, run `node "<scripts>/setup.mjs"`. Explain the one-time browser download. Linux may also require `npx --prefix ~/.rudi-sim playwright install-deps webkit`; use the configured RUDI_SIM_HOME instead of ~/.rudi-sim when set. If downloads, system libraries, or site access are blocked, report the actual error and which checks remain unverified.
- Use a URL reachable from the execution environment. In cloud Work, `localhost` refers to the cloud workspace, not the user's computer. A site served in that workspace is reachable; a site served only on the user's laptop needs a preview URL or an explicitly configured connection.
- Use the platform's supported browser interface for ordinary signed-in browser tasks. Use these scripts for the explicitly requested simulation/testing workflow. Obtain an authorized test session for private-site tests; never assume the user's normal browser cookies are available.
- Use headless mode in cloud environments. A headed window on a remote machine is not visible on the user's desktop. Do not claim a live viewer exists.
- Do not submit real purchases, publish content, send messages, or change accounts merely to test a flow. Use a test fixture or stop before an action that is outside the user's authorization.

## Device checks

List devices with `node "<scripts>/check.mjs" --list`. Use `--device "iPhone SE, iPhone 16 Pro Max, iPad mini"`, groups such as `ipads`, or custom sizes such as `390x844`. Honor the requested selection; when none is specified, use the script's default set. Resolve ambiguous device names from the choices the script returns.

Run:

```sh
node "<scripts>/check.mjs" "<url>" --device "<devices>" --themes light,dark --out "<output>/checks"
```

Add `--landscape` or `--viewport-only` when relevant. Leave the engine as WebKit. Open every screenshot used in the assessment with the available image-viewing tool. Start with the narrowest phone, then tablets. Inspect clipping, overlaps, unreadable colors, missing media, navigation, and fixed headers. Include reported overflow, JavaScript errors, failed pages, and truncated screenshots. A zero exit code alone does not mean all screenshots succeeded; inspect `NOT saved` and the reported problems. Report the number and identity of checks completed, with failures and inaccessible states explicitly marked.

## Recorded walkthroughs

Start a long-lived command using the execution tool's persistent process/session facility:

```sh
node "<scripts>/walk.mjs" start "<url>" --device "iPhone 16" --headless --single --out "<output>/walk"
```

Wait for `READY` before issuing actions. Preserve the running process across calls; do not let a short shell timeout kill it. For requested side-by-side layouts, omit `--single` and provide multiple device names; describe them as layout comparisons because the frames share desktop Safari identity and pixel density.

Drive one action at a time with `node "<scripts>/walk.mjs" do <action> [args]`:

- `look`: inspect the screenshot and tappable elements first.
- `say "caption"`: explain each section in the recording.
- `click "visible text or selector"`; `type "field label" "text"`; `press Enter`.
- `scroll down`, `back`, `goto /path`, `theme dark`.
- `device "iPad mini"`: change device while preserving the session. Inspect again after changing device.

Use the returned screenshot and current element list to choose the next action. Do not guess a successful click after an error. Open phone navigation before clicking hidden links. Stop and save the video with `node "<scripts>/walk.mjs" stop`, including on failure. Inspect key screenshots before reporting results. Each recording belongs to the current execution session; do not promise it will remain controllable in a later conversation.

Saved tours can run with `node "<scripts>/walk.mjs" tour "<tour-file>" "<url>" --headless --out "<output>/tour"`. Inspect the printed step results: tours carry on after failed steps, so a completed process is not proof the tour passed. Save new tours outside the installed plugin. Do not include credentials in tours or recordings.

## Compare original and proposed layouts

Use two reachable previews of the same website, one for the original code and one for the proposed branch. Keep the original checkout unchanged. Start comparison in headless Screens mode:

```sh
node "<scripts>/walk.mjs" start "<original-url>" --compare "<proposed-url>" --device "iPhone 17, iPhone Duo (open), 1280x800, 1920x1080" --landscape --headless --out "<output>/compare"
```

Do not add --single: comparison requires Screens mode and cannot run as a saved tour. Use the requested devices and explicit sizes instead of silently assuming what medium, large, or widescreen means. Resolve "18 Duo" against the available folded/open Duo presets; do not invent a device match.

Every device has Before and After frames. Model-issued clicks, typing, scrolling, navigation, rotation, and device changes apply to both sides. Use do compare "<url>" to enable comparison in a running Screens session, or do compare off to disable it. Compare maps the original page path, query, and fragment to the second URL's origin; previews with different path prefixes need separate screenshot checks. Cross-site sign-in cookies may be blocked. Each step ends with OK:, PARTIAL: (done on some screens only; the lines below say which) or FAILED:, and lists Screens ready: N of M with the reason for any screen that didn't load. Never call a comparison successful unless every screen is ready; name the failed screen and use do retry after the cause is fixed. Use --seed <n> so data the page makes with Math.random() matches on both sides; it seeds only Math.random(), not clocks, animations or server data. Clicks a person makes directly in the window stay in that one screen.

Inspect the actual paired screenshots. Report any side that failed or fell out of step. Do not describe model-issued synchronized actions as a user-operated live viewer in ChatGPT web. Return the paired screenshots and finalized recording.

Comparison frames share desktop Safari identity and pixel density. Also run check.mjs separately on both previews with identical devices, themes, and orientation for device-specific validation. Keep pages and test data equivalent; identify dynamic content or authentication differences that make a comparison unfair.

When asked to propose visual edits, use authorized source access to prepare an isolated branch and preview, inspect layouts, edit, and retest. Present original/proposed evidence and the proposed commit before asking for approval. A screenshot comparison is not permission to merge or publish. Apply requested revisions and regenerate evidence for the revised commit. Without source access, complete the visual review and explain that edits remain blocked.

## Deliver results

Lead with the observed outcome. Identify the URL, devices, themes, and tested flow. Show representative screenshots inline with absolute sandbox image links, then link the saved WebM recording and relevant images using absolute sandbox file targets. Preserve user deliverables using the platform's supported file-saving workflow when available. If WebM cannot preview in the client, offer the file for download; do not claim inline playback. Separate observed defects from untested device behavior. Report runtime or network blockers without inventing results.
