#!/bin/bash
# Removes the Form Worker's sign-in start. The worker itself is not stopped.
AGENT="$HOME/Library/LaunchAgents/com.eternalgy.form-worker.plist"
launchctl unload "$AGENT" 2>/dev/null
rm -f "$AGENT" && echo "Autostart is off."
read -r -p "Press Return to close." _
