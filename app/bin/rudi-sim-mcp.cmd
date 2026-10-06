@echo off
rem ChatGPT's tunnel runs this to reach the Rudi-Sim app. It starts the bridge
rem with the app's own runtime, so Node.js doesn't need to be installed.
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\Rudi-Sim.exe" "%~dp0..\engine\integrations\local-bridge\server.mjs" %*
