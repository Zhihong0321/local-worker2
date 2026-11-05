#!/bin/bash
ROOT="$(cd "$(dirname "$0")" && pwd)"
PY="$("$ROOT/app/runtime.sh")" && "$PY" "$ROOT/app/worker.py" --autostart off
read -r -p "Press Return to close." _
