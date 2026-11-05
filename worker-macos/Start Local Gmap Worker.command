#!/bin/bash
# Local Gmap Worker. Keeps the worker running; it restarts itself if it ever stops.
# Double-click in Finder to open it in Terminal; launchd runs it the same way at sign-in.

# Follow the desktop shortcut back to this folder.
SELF="$0"
while [ -L "$SELF" ]; do
  LINK="$(readlink "$SELF")"
  case "$LINK" in /*) SELF="$LINK" ;; *) SELF="$(dirname "$SELF")/$LINK" ;; esac
done
ROOT="$(cd "$(dirname "$SELF")" && pwd)"
printf '\033]0;Local Gmap Worker\007'

while true; do
  if PY="$("$ROOT/app/runtime.sh")"; then
    "$PY" "$ROOT/app/worker.py"
    code=$?
  else
    echo "Python could not be set up (see above)."
    code=1
  fi
  [ "$code" -eq 2 ] && break
  echo "The worker stopped. Restarting in 15 seconds..."
  sleep 15
done
if [ -t 0 ]; then read -r -p "Press Return to close." _; fi
