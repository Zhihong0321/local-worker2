#!/bin/bash
printf '\033]0;LinkedIn sign in\007'
ROOT="$(cd "$(dirname "$0")" && pwd)"
DATA="${LOCAL_GMAP_WORKER_DATA:-$HOME/Library/Application Support/LocalGmapWorker}"
PYTHON="$DATA/venv/bin/python"
SESSION="$DATA/linkedin_session.json"
if [ -f "$ROOT/worker.env" ]; then
  while IFS= read -r line; do
    case "$line" in
      LINKEDIN_PYTHON=*) PYTHON="$(echo "${line#*=}" | sed 's/^ *"*//; s/"* *$//')" ;;
      LINKEDIN_SESSION=*) SESSION="$(echo "${line#*=}" | sed 's/^ *"*//; s/"* *$//')" ;;
    esac
  done < "$ROOT/worker.env"
fi
if [ ! -x "$PYTHON" ]; then
  echo "Start the worker first to install LinkedIn."
else
  echo "Sign in to LinkedIn in the browser and wait for your feed."
  if "$PYTHON" "$ROOT/../worker/linkedin_login.py" "$SESSION"; then
    echo "LinkedIn session saved. The worker will pick it up shortly."
  else
    echo "Login failed. Please try again."
  fi
fi
read -r -p "Press Return to close." _
