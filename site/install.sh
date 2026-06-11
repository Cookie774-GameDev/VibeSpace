#!/usr/bin/env sh
# Jarvis GitHub Pages installer shim.
# The canonical installer lives in install/install.sh in the repo.
set -eu
if ! command -v bash >/dev/null 2>&1; then
  echo "Jarvis installer requires bash. Install bash or run the Windows PowerShell installer." >&2
  exit 1
fi
curl -fsSL https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.sh | bash
