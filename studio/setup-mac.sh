#!/usr/bin/env bash
# One-time setup for Reel Studio on a Mac (Apple Silicon or Intel).
#   cd studio && ./setup-mac.sh
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v brew >/dev/null; then
  echo "Homebrew is needed first: https://brew.sh (paste the one-line install from there, then re-run this)."
  exit 1
fi

echo "→ ffmpeg + Python"
brew list ffmpeg >/dev/null 2>&1 || brew install ffmpeg
brew list python@3.12 >/dev/null 2>&1 || brew install python@3.12
PY="$(brew --prefix python@3.12)/bin/python3.12"

echo "→ Python packages (in studio/.venv)"
"$PY" -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
if [[ "$(uname -m)" == "arm64" ]]; then
  .venv/bin/pip install -q mlx-whisper   # fast on-device speech-to-text on Apple Silicon
else
  .venv/bin/pip install -q faster-whisper
fi

echo "→ Fonts"
mkdir -p fonts
fetch() { [[ -f "fonts/$1" ]] || curl -fsSL -o "fonts/$1" "$2" || echo "  (couldn't download $1, using a system font)"; }
fetch PlayfairDisplay.ttf "https://github.com/google/fonts/raw/main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf"
fetch Montserrat.ttf "https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf"
fetch VT323.ttf "https://github.com/google/fonts/raw/main/ofl/vt323/VT323-Regular.ttf"
fetch SpaceMono.ttf "https://github.com/google/fonts/raw/main/ofl/spacemono/SpaceMono-Regular.ttf"

[[ -f .env ]] || cp .env.example .env
mkdir -p "$HOME/Trip Footage/Inbox"

echo
echo "Done. Next:"
echo "  1. open -e .env   (paste your ANTHROPIC_API_KEY, the same one the trip bot uses)"
echo "  2. ./studio serve   (then open http://localhost:8787)"
echo "  3. Drop tonight's GoPro + iPhone clips into ~/Trip Footage/Inbox"
