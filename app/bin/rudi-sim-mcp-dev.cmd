@echo off
rem Development version of rudi-sim-mcp.cmd: runs the bridge from this checkout.
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\node_modules\electron\dist\electron.exe" "%~dp0..\..\integrations\local-bridge\server.mjs" %*
