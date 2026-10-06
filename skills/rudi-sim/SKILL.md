---
name: rudi-sim
description: Show a web page the way Safari draws it on any Apple device (iPhone SE to 18 Pro Max and iPhone Duo, iPads, MacBooks, iMac). Two modes - watch mode opens a visible window showing one or more device screens (with a Screens checklist the user can change) that Claude taps through step by step while the user watches, and check mode takes light/dark screenshots on several devices. Use when asked to simulate, preview or check a site on iPhone, iPad, Mac or Safari, to compare a site before and after a change side by side, or to walk through a site or app.
argument-hint: <url> [on <device>] [check]
---

# Rudi-Sim

This uses Playwright's **WebKit** engine (the engine inside Safari) with each Apple device's screen size, pixel density, touch and Safari user agent. It is not Apple's iOS Simulator (that needs a Mac with Xcode). It catches layout, overflow, font, dark mode and most Safari-only CSS problems, but not iOS-only things like the on-screen keyboard or the Safari toolbar shrinking. Say so when a result depends on those.

Scripts live in this skill's folder: `${CLAUDE_SKILL_DIR}/scripts/`. If that isn't filled in, use `~/.claude/skills/rudi-sim/scripts/` (on Windows `%USERPROFILE%\.claude\skills\rudi-sim\scripts\`). Below, `<scripts>` means that folder.

## First run

If a script says Playwright isn't set up, run `node <scripts>/setup.mjs` once. It needs Node 18+ and installs Playwright plus WebKit into `~/.rudi-sim` (about 300 MB). Tell the user it's a one-time download.

## Picking a device

`node <scripts>/check.mjs --list` prints all 39 devices. Names are forgiving: `"iPhone 16 Pro"`, `16pro`, `"iPad mini"`, `imac`, `"MacBook Air 13"`. Groups: `iphones`, `ipads`, `macs`, `all`, `default`. **Custom sizes** work anywhere a device name does: `390x844`, `1280x800@1` (pixel scale), `800x1280 tablet` (phone, tablet or desktop; otherwise guessed from the width). The user can also add a custom size from the Screens checklist. If the user doesn't name one, use iPhone 16 for watch mode. If a name matches several or none, the script says so; show the user the choices and ask.

## Watch mode (the user watches you click through a site)

Use this when the user wants to see the site being used, or says "walk through", "show me", "simulate", "demo it".

1. Start the window **in the background** (Bash with `run_in_background`, because it keeps running):
   `node <scripts>/walk.mjs start <url> --device "iPhone 16"`
   Add `--theme dark` or `--landscape` if asked. `--name <project>` names the recording folder; `--seed <n>` makes the page's `Math.random()` give the same numbers on both sides of a comparison (only that: clocks, animations and server data still differ); `--pane-timeout <ms>` changes how long a screen may take to load (default 30000); `--ignore-https-errors` accepts a local site's self-made certificate. A local dev server works too, e.g. `localhost:3000`.
   A Safari window opens on the user's screen with that device's screen in it and a **Screens** checklist at the top, so the user can add or remove screens at any time. Tell them to watch it.
   **Before and after:** to compare the current site with a changed version (a branch running on another port, a staging site), add `--compare <second url>`: every screen shows twice, **Before** (the first url) beside **After** (the same page on the second url), at the same size. Every step happens on both; a `goto /path` opens that path on both sites. To compare a branch with the current code, if the user has a trusted project file, `node <scripts>/preview.mjs start <file> --open` starts both versions and opens the window (see `docs/PREVIEWS.md`; never write or trust a project file for the user without asking, since it runs commands). Otherwise run the branch from its own folder (`git worktree add ../site-after <branch>`) on a second port. An `https` site beside an `http` one works. A running window can switch with `do compare <url>` and `do compare off`. Sign-ins work on both sides when both addresses are on the same host (two `localhost` ports); with two different sites (say the live site and `localhost`), the browser may block the After side's sign-in cookies, so compare two local ports for signed-in pages. When reporting, say what differs between Before and After on each screen.
   **Several screens at once:** name more than one device, e.g. `--device "iPhone 16, iPad mini, iMac"` (or a group like `ipads`). Every screen shows side by side in the one window, all shrunk by the same amount so their proportions stay true. The user can tick screens on and off from the **Screens** checklist. Every step (tap, type, scroll, back) happens on all the screens together. If a button only exists on some screens (a phone menu, say), the step reports which screens it wasn't found on, and those screens fall out of step; bring them back with `goto` to the same page. If a click fails because the thing is hidden, the error says so: open the phone menu first.
2. Drive it one step at a time, each a normal (foreground) command:
   `node <scripts>/walk.mjs do <action> [args]`
   - `look`: screenshot plus a list of what's tappable on screen. Start with this.
   - `click "<words on the button, link or tab>"` (or a CSS selector)
   - `type "<field label or placeholder>" "<text>"`, `press Enter`
   - `scroll down|up|top|bottom`, `back`, `goto /path`, `wait 1000`
   - `say "<text>"`: shows a caption in the window, so the user knows what you're doing. Use it before each new section.
   - `device "iPad mini"`: switch device on the same page, staying signed in. `device "iPhone 16, iPad mini, iMac"` switches to several side by side.
   - `menu`: open or close the Screens checklist so the user can see it (not in a `--single` window)
   - `compare <url>`: show each screen twice, Before and After (the same page on `<url>`); `compare off` goes back to one of each
   - `rotate "iPhone Duo (open)"`: turn that screen 90°; again turns it back. No name turns every screen. The user can also use the ⟳ button under each screen.
   - `actual "iPhone 16"`: show that one screen at its actual size, with the others hidden; `actual` with no name shows them all again. The user can also use the ⤢ button under each screen.
   - `theme dark|light`
   - `retry`: load again only the screens that didn't load (`retry all`, or name screens)
   - `stop`: close the window and save the video. It prints `Recording folder:` and the finished video's path.
   Each step ends with `OK:`, `PARTIAL:` (done on some screens, not all; the lines below say which and why) or `FAILED:`. In a multi-screen window it also prints `Screens ready: N of M` and names any screen that isn't loaded, with the reason (nothing running at that address, still loading, blocked). Never report a comparison as working unless every screen is ready; tell the user which one failed and offer `retry` once they've fixed it. Steps you run happen on every screen; clicks the user makes in the window stay in the screen they clicked. Each step prints a screenshot path, the page, any JS errors since the last step, and on `look` or a failed click, what's tappable. Open the screenshots with the Read tool when you need to judge something; a red dot and caption show in the window and the video but are hidden from screenshots.
3. Go at a pace a person can follow. Narrate in the window with `say`, not only in chat.
4. When done, run `stop` and tell the user where the video (`walkthrough-*.webm`, plays in Chrome or Edge) and screenshots are, plus anything that looked broken.

For a hands-off run, `node <scripts>/walk.mjs tour <name or file> [url] [--device ...]` plays a saved tour in a visible window and stops at the end; pass a url to point it at another address. Tours are JSON files in `scripts/tours/` (see `example.json`) with `url`, `device` and `steps` of `{ "do": action, "target" or "args", "say": caption, "optional": true }`. Offer to save a walkthrough the user liked as a tour.

## Check mode (screenshots on several devices)

Use this for "check this page on iPhone/iPad/Mac" or after a layout change.

`node <scripts>/check.mjs <url> [--device "iPad mini, iPhone 16"] [--themes light,dark] [--landscape] [--viewport-only]`

With no `--device` it uses the default set (iPhone SE, 16, 16 Pro Max, iPad mini, iPad, MacBook Air 13-inch, iMac 24-inch). It saves full-page screenshots named `<device>-<theme>.png` and lists JS errors and sideways scrolling per device.

Then:
1. Open each screenshot with the Read tool. Don't report on screenshots you didn't look at.
2. Look at the narrowest phone first, then the iPads, where layouts often fall between phone and desktop.
3. Look for text cut off or overlapping, buttons too small or touching, content wider than the screen, unreadable colors in dark mode, missing images or fonts, fixed headers covering content.
4. Report problems per device and theme in plain words with the folder path. If nothing is wrong, say so in one line.

## Notes

- A URL without `http` gets `https://`, except `localhost` and local network addresses, which get `http://`.
- Output goes to `rudi-sim/` inside the current folder unless `--out` is given.
- Mac sizes are the whole screen at Apple's default scaling; a real Safari window is a bit smaller.
- Side-by-side screens are frames inside one Safari window: each has the device's real width and height (less the status bar beside a notch or Dynamic Island, which the user can switch off in the checklist), so layouts and breakpoints are right, but they share the window's pixel density and the Mac version of Safari's identity. For exact per-device rendering (an iPhone's own Safari identity, touch and pixel density) add `--single` to `start` (also when the user asks for one device "on its own"), which opens one window the size of that device with no Screens checklist, or use check mode.
- `--theme` only changes sites that follow the device's light/dark setting; sites with their own theme switch ignore it.
- The device list is `scripts/devices.json`. To add one, add an entry there.
