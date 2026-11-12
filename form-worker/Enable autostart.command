#!/bin/bash
# Starts the Form Worker every time this Mac's user signs in (a LaunchAgent). Run once, on this Mac.
ROOT="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.eternalgy.form-worker"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Application Support/FormWorker"
mkdir -p "$HOME/Library/LaunchAgents" "$LOGS"

cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/Start Form Worker.command</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOGS/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$LOGS/launchd.log</string>
</dict>
</plist>
PLIST

launchctl unload "$AGENT" 2>/dev/null
launchctl load "$AGENT" && echo "Autostart is on. The Form Worker starts at sign-in."
read -r -p "Press Return to close." _
