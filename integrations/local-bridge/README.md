# Rudi-Sim local bridge (preview)

This optional MCP stdio server runs on your Windows, macOS, or Linux computer. It opens a visible Playwright WebKit Screens window locally and lets an MCP client start, inspect, click, type, scroll, rotate, change devices/themes, compare two hosts, and stop it. Screenshots return to the model; recordings stay on your computer. This is WebKit emulation, not Apple's iOS Simulator or a real iPhone.

Existing Claude plugin files and shared scripts are unchanged. The bridge installs dependencies under `~/.rudi-sim-bridge` (`RUDI_BRIDGE_HOME` overrides this), and every connection has separate simulator state. It does not attach to or stop a Claude window. Keep the bridge/tunnel running during a walkthrough. Disconnecting its stdio input closes its window and finalizes video. Restarting the connection requires a new simulator session. Hard termination or power loss can prevent recording finalization.

## One-time setup on Windows

Install Node.js 18+ and Git. Clone this repository and check out the bridge branch while it is under review. In PowerShell, from the repository directory:

```powershell
node .\integrations\local-bridge\setup.mjs
node --test .\integrations\local-bridge\test.mjs
```

Setup downloads Playwright and WebKit. Linux may need Playwright's system dependencies, installed by your administrator. A Mac is not required. For an automated headless check:

```powershell
node .\integrations\local-bridge\smoke.mjs
```

Normal bridge sessions are **visible**. `RUDI_BRIDGE_HEADLESS=1` is an operator-only automation setting; leave it unset for watching locally.

## Claude Code or another local MCP client

Configure the client to launch Node with the absolute script path, for example:

```json
{
  "mcpServers": {
    "rudi-sim-local": {
      "command": "node",
      "args": ["C:\\rudi-sim\\integrations\\local-bridge\\server.mjs"]
    }
  }
}
```

Use your actual checkout path. The existing Claude skill/CLI still works independently.

## ChatGPT connection through Secure MCP Tunnel

A plugin archive alone cannot connect ChatGPT web to your laptop. Use OpenAI's private [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). Availability requires Platform tunnel permissions, association with the intended ChatGPT workspace, and permission to create/use custom MCP servers. This repository cannot grant those permissions. Tunnel support is for private connections; this does not make a publicly distributable one-click plugin.

Download `tunnel-client` from Platform tunnel settings or the [latest official release](https://github.com/openai/tunnel-client/releases/latest). Create a tunnel associated with your ChatGPT workspace. Keep its runtime API key in the tunnel client's environment; the bridge does not need or read an API key. In PowerShell (replace the path and tunnel identifier; don't paste secrets in chat):

```powershell
# Set CONTROL_PLANE_API_KEY locally using your preferred secret-handling method.
tunnel-client init --sample sample_mcp_stdio_local --profile rudi-sim --tunnel-id tunnel_YOUR_ID --mcp-command 'node C:/rudi-sim/integrations/local-bridge/server.mjs'
tunnel-client doctor --profile rudi-sim --explain
tunnel-client run --profile rudi-sim
```

Use a checkout path without spaces for this example; consult `tunnel-client help quickstart` for quoting commands in other paths. Keep the client running. In ChatGPT Plugins, use the plus button → Add custom MCP server → Connection: Tunnel, select this tunnel, review the authentication and tools, and create the plugin. If Tunnel is unavailable or discovery fails, verify the account/workspace permissions and associations described in the official guide. Do not expose the simulator's unauthenticated `/do` endpoint publicly as a workaround.

Then ask: “Use Rudi-Sim Local to open https://example.com next to http://localhost:5001 on iPhone 17 landscape. Scroll both and show me the comparison.” ChatGPT calls `rudi_start`, inspects the screenshot, then uses `rudi_action`. You watch the actual WebKit window on the computer running the bridge. This does not stream an interactive viewer inside ChatGPT.

Comparison copies the original path/query/fragment onto the proposed origin. Use matching paths on both hosts. An https site beside an http one loads on both sides. Every `rudi_start` and `rudi_action` answer lists each screen (`panes`) with its state (`ready`, `loading`, `error`, `missing`), the address asked for and the one shown, and the reason when it isn't ready; `ok` is false unless every screen loaded, and the `retry` action reloads only the failed ones. Steps report per-screen `results` and `partial: true` when only some screens did them. Cross-site sign-in cookies or a site that refuses to be framed can still block one side; that is reported, never shown as success.

Recordings go to `Rudi-Sim Recordings` in the home folder (`RUDI_SIM_RECORDINGS` overrides), one readable folder per session with a `session.json`; `rudi_stop` returns the folder and the finished video's path and size, and `rudi_status` returns the last recording even after the window closed. `rudi_start` also accepts `project` (the name of a project the user trusted with `preview.mjs trust`; see `docs/PREVIEWS.md`), `name`, `seed` and `ignoreHttpsErrors` (localhost only).

For a desktop app with the tunnel key kept in the system's password store, one simulator shared by Claude Code and ChatGPT, and a recordings library, use the [Rudi-Sim app](../../docs/DESKTOP.md). Grid frames share desktop Safari identity/density. Use the existing `check.mjs` separately for exact device-context validation.

## Scope and implementation

Four tools: `rudi_start`, `rudi_action`, `rudi_status`, `rudi_stop`. No arbitrary shell, filesystem-reading tool, or browser-cookie import. Only HTTP(S) URLs without embedded credentials, bounded arguments, and an explicit simulator action list are accepted. Images must resolve inside the owned output directory and be PNG files no larger than 8 MiB. Local recording paths are reported, not uploaded as videos automatically.

Use authorized sites and test accounts. The bridge can interact with local/private sites and submit forms, so the model must respect the user's requested action scope. Screenshots and page text sent through MCP leave the local computer. Authentication/access control belongs to the local MCP client or Secure MCP Tunnel; this stdio process has no public network listener.

The adapter implements the legacy MCP stdio handshake (2024-11-05 through 2025-11-25), tools discovery/calls, and ping with newline JSON-RPC. A newer client must accept a negotiated supported version. Calls are serialized. Cancellation notifications currently do not abort a browser action already underway; browser requests time out after 45 seconds. No autonomous website editing, GitHub merging, or publishing tool is added.

## Validation

`node --test integrations/local-bridge/test.mjs` covers input rejection, screenshot confinement, actual stdio negotiation/discovery/error results, and EOF exit. `node integrations/local-bridge/smoke.mjs` exercises real WebKit on two local origins, synchronized clicks, rotation/theme screenshots, and finalized nonempty videos. CI runs protocol tests on Linux/macOS/Windows and WebKit smoke on Linux/Windows. A headed Windows walkthrough and end-to-end ChatGPT tunnel connection still need verification on the user's machine/account before calling this ready for general use.
