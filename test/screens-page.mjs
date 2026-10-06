#!/usr/bin/env node
// Drives the Screens checklist directly: the custom-size boxes keep what you typed
// when you click away, and Add puts that size on screen.
// Usage: node test/screens-page.mjs [--engine webkit|chromium]
import { launchOptions, loadPlaywright } from "../skills/rudi-sim/scripts/lib.mjs";
import { screensPage } from "../skills/rudi-sim/scripts/viewer.mjs";

const engine = process.argv.includes("--engine") ? process.argv[process.argv.indexOf("--engine") + 1] : "webkit";

const pw = await loadPlaywright();
const browser = await pw[engine].launch(launchOptions({ headless: true }));
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.route("http://sim.test/**", (r) => r.fulfill({ contentType: "text/html",
    body: r.request().url().includes("/__sim/screens") ? screensPage() : "<h1>hi</h1>" }));
  await page.goto("http://sim.test/__sim/screens#" + encodeURIComponent(JSON.stringify({ keys: ["imac"], url: "http://sim.test/" })));
  await page.click("#pick");
  await page.fill(".cust input[name=w]", "500");
  await page.click(".cust input[name=h]");
  await page.fill(".cust input[name=h]", "900");
  await page.click("#menu h4");
  const typed = [await page.inputValue(".cust input[name=w]"), await page.inputValue(".cust input[name=h]")];
  if (typed.join("x") !== "500x900") { failed = true; console.log(`the boxes cleared when clicking away (got "${typed.join('" × "')}")`); }
  await page.click(".cust button");
  const keys = await page.evaluate(() => window.__screens.keys());
  if (!keys.includes("custom-500x900")) { failed = true; console.log(`Add didn't put 500×900 on screen (screens: ${keys.join(", ")})`); }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
