#!/usr/bin/env sh
# Jarvis GitHub Pages installer shim.
# The canonical installer lives in install/install.sh in the repo.
set -eu
curl -fsSL https://raw.githubusercontent.com/anomalyco/jarvis/main/install/install.sh | sh
