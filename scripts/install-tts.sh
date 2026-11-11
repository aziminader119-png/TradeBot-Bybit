#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if ! command -v python3 >/dev/null; then
  echo 'Python 3 is required for voice generation.' >&2
  exit 1
fi
python3 -m venv .venv-tts
.venv-tts/bin/python -m pip install --disable-pip-version-check 'edge-tts==7.3.1'
echo 'Speech engine installed. Restart TradeBot and try the voice preview.'
