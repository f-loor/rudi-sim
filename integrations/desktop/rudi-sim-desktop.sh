#!/bin/sh
# Rudi-Sim desktop companion for macOS and Linux. With no arguments it starts in
# the background and opens the status page; otherwise it passes them on.
here="$(cd "$(dirname "$0")" && pwd)"
command -v node >/dev/null 2>&1 || { echo "Node.js isn't installed. Get it from https://nodejs.org and try again."; exit 1; }
if [ $# -eq 0 ]; then
  node "$here/rudi-sim-desktop.mjs" start && node "$here/rudi-sim-desktop.mjs" open
else
  exec node "$here/rudi-sim-desktop.mjs" "$@"
fi
