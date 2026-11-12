#!/bin/bash
# Form Worker: checks lead websites for a contact form and sends contact-form messages on this Mac.
# Restarts itself if it ever stops. Exit code 2 means nothing to do or not set up, and it stops.
# Double-click in Finder to open it in Terminal; the LaunchAgent (Enable autostart.command) runs it at sign-in.

# Follow a desktop shortcut back to this folder.
SELF="$0"
while [ -L "$SELF" ]; do
  LINK="$(readlink "$SELF")"
  case "$LINK" in /*) SELF="$LINK" ;; *) SELF="$(dirname "$SELF")/$LINK" ;; esac
done
ROOT="$(cd "$(dirname "$SELF")" && pwd)"
printf '\033]0;Form Worker\007'

pause_if_terminal() { if [ -t 0 ]; then read -r -p "Press Return to close." _; fi; }

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 22 or newer from nodejs.org, then open this again."
  pause_if_terminal
  exit 2
fi

cd "$ROOT" || exit 1
if [ ! -d node_modules ]; then
  echo "Installing the browser library (first start only)..."
  if ! npm install --omit=dev; then
    echo "npm install failed. See the messages above."
    pause_if_terminal
    exit 1
  fi
fi

while true; do
  node worker.mjs
  code=$?
  [ "$code" -eq 2 ] && break
  echo "The worker stopped. Restarting in 15 seconds..."
  sleep 15
done
pause_if_terminal
