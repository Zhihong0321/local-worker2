#!/bin/bash
# The worker's own Python, set up once under ~/Library/Application Support/LocalGmapWorker:
# the macOS counterpart of the embeddable Python worker.ps1 unpacks on Windows.
# uv fetches a standalone CPython (no admin, no Homebrew, no Xcode tools) into a
# venv seeded with pip, so worker.py can add its packages later. Prints the
# venv's python on stdout; everything else goes to stderr.
set -euo pipefail

DATA="${LOCAL_GMAP_WORKER_DATA:-$HOME/Library/Application Support/LocalGmapWorker}"
PY_VERSION=3.12
UV_VERSION=0.11.16
VENV="$DATA/venv"
STAMP="$VENV/runtime.txt"
WANT="$PY_VERSION certifi"

if [ -x "$VENV/bin/python" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$WANT" ]; then
  echo "$VENV/bin/python"
  exit 0
fi
mkdir -p "$DATA"

# A uv already on this Mac, else one of the worker's own.
UV=""
for c in "$DATA/uv/uv" "$HOME/.local/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv; do
  if [ -x "$c" ]; then UV="$c"; break; fi
done
if [ -z "$UV" ] && command -v uv >/dev/null 2>&1; then UV="$(command -v uv)"; fi
if [ -z "$UV" ]; then
  case "$(uname -m)" in
    arm64) ARCH=aarch64 ;;
    *) ARCH=x86_64 ;;
  esac
  echo "setting up Python: downloading uv $UV_VERSION, once" >&2
  rm -rf "$DATA/uv" && mkdir -p "$DATA/uv"
  curl -fsSL "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$ARCH-apple-darwin.tar.gz" \
    | tar -xz -C "$DATA/uv" --strip-components 1
  UV="$DATA/uv/uv"
fi

echo "setting up Python $PY_VERSION, about 40 MB, once" >&2
rm -rf "$VENV"
UV_PYTHON_INSTALL_DIR="$DATA/python" "$UV" venv --quiet --seed --managed-python --python "$PY_VERSION" "$VENV" >&2
# A standalone Python may not find the system's CA certificates; worker.py uses certifi's.
"$VENV/bin/python" -m pip install --quiet --disable-pip-version-check certifi >&2
echo "$WANT" > "$STAMP"
echo "$VENV/bin/python"
