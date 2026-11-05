#!/bin/bash
ROOT="$(cd "$(dirname "$0")" && pwd)"
PY="$("$ROOT/app/runtime.sh")" && "$PY" "$ROOT/app/worker.py" --autostart on
read -r -p "Press Return to close." _
