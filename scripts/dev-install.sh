#!/usr/bin/env bash
# dev-install — package the extension and install the fresh VSIX into the
# local VS Code via its CLI (consumed by the .vscode/tasks.json task
# "dev: package + install").
#
# Packaging is a straight `vsce package` — readable JS out, no obfuscation.
# Run `npm run verify` before this when sources changed. After install,
# RELOAD the window (Developer: Reload Window) — VS Code does not hot-swap
# an installed extension's files.
set -euo pipefail
cd "$(dirname "$0")/.."

echo '[dev-install] packaging...'
npx vsce package --skip-license

vsix="$(ls -t ./*.vsix | head -1)"
echo "[dev-install] artifact: ${vsix#./}"

# CLI discovery: PATH first, then the standard macOS app-bundle location.
code_cli="$(command -v code || true)"
if [ -z "$code_cli" ] && [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
  code_cli="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
fi
if [ -z "$code_cli" ]; then
  echo '[dev-install] VS Code CLI (code) not found — put it on PATH or adjust the fallback path in this script.' >&2
  exit 1
fi

echo "[dev-install] installing into VS Code: $code_cli"
"$code_cli" --install-extension "$vsix" --force

echo ''
echo '[dev-install] DONE — RELOAD the window (Developer: Reload Window) to run the new build.'
