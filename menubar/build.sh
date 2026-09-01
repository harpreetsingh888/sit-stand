#!/bin/bash
#
# Build the menu bar companion into menubar/DeskLog.app.
# Needs the Xcode command line tools: xcode-select --install
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/DeskLog.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"

swiftc -O -target arm64-apple-macos13.0 \
  -o "$APP/Contents/MacOS/DeskLog" "$HERE/DeskLog.swift"

# An ad-hoc signature is enough to run locally and keeps macOS from complaining.
codesign --force --sign - "$APP" 2>/dev/null || echo "note: could not sign; the app still runs"

echo "Built $APP"
echo "Run it with: open $APP"
