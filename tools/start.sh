#!/usr/bin/env bash
# Start everything the agent needs around the game, in one place:
#
#   game-tap        window video + audio: recording (rewind), live frames, PCM
#   asr-daemon      speech recognition of the game audio ("heard")
#   vision-daemon   depth + objects from the live frames ("scene")
#   capture-daemon  the single socket the sandboxed MCP server talks to
#
# Usage: tools/start.sh [portal2|portal] [--vlm] [--no-audio]
#        tools/start.sh stop
#
# Logs and state live in .local/; each daemon is restarted if already running.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
LOCAL="$ROOT/.local"
GAME="${1:-portal2}"
shift || true
WANT_VLM=""
AUDIO=1
for arg in "$@"; do
  case "$arg" in
    --vlm) WANT_VLM="--vlm" ;;
    --no-audio) AUDIO=0 ;;
  esac
done

ASR_PYTHON="${ASR_PYTHON:-$HOME/Projects/asr-ru-перенос/код/.venv/bin/python}"
VISION_PYTHON="${VISION_PYTHON:-$LOCAL/venv-vision/bin/python}"

stop_all() {
  pkill -f "tools/start.sh" 2>/dev/null || true   # the keep-alive loops
  pkill -f "$ROOT/.local/bin/game-tap" 2>/dev/null || true
  pkill -f "tools/asr-daemon.py" 2>/dev/null || true
  pkill -f "tools/vision-daemon.py" 2>/dev/null || true
  pkill -f "tools/mac-capture-daemon.py" 2>/dev/null || true
}

if [ "$GAME" = "stop" ]; then
  stop_all
  echo "stopped"
  exit 0
fi

case "$GAME" in
  portal2) APP=portal2.exe; TITLE="PORTAL 2 - Direct3D 9"; PORT=27184 ;;
  portal)  APP=hl2.exe;     TITLE="Portal - Direct3D 9";   PORT=27183 ;;
  *) echo "unknown game: $GAME (use portal2 or portal)" >&2; exit 1 ;;
esac

stop_all
sleep 1
mkdir -p "$LOCAL/bin"

# Build the capture tool if the source is newer than the binary.
if [ ! -x "$LOCAL/bin/game-tap" ] || [ tools/game-tap.swift -nt "$LOCAL/bin/game-tap" ]; then
  echo "building game-tap…"
  swiftc -O -o "$LOCAL/bin/game-tap" tools/game-tap.swift
fi

REC="$LOCAL/rec-$GAME"
FRAMES="$LOCAL/frames-$GAME"
HEARD="$LOCAL/heard-$GAME.jsonl"
SCENE="$LOCAL/scene-$GAME.jsonl"
mkdir -p "$REC" "$FRAMES"

# The capture stream dies when the game window is recreated (resolution change,
# game restart), and a dead stream stops the agent, so it is kept alive here.
if [ "$AUDIO" = 1 ] && [ -x "$ASR_PYTHON" ]; then
  ( while true; do
      "$LOCAL/bin/game-tap" --app "$APP" --record "$REC" --frames "$FRAMES" \
          --audio-raw "$LOCAL/audio-$GAME.f32" --fps 10 --segment 10 2>>"$LOCAL/tap.log" \
        | "$ASR_PYTHON" tools/asr-daemon.py --out "$HEARD" >>"$LOCAL/asr.log" 2>&1
      sleep 3
    done ) &
else
  ( while true; do
      "$LOCAL/bin/game-tap" --app "$APP" --record "$REC" --frames "$FRAMES" \
          --fps 10 --segment 10 --no-audio >/dev/null 2>>"$LOCAL/tap.log"
      sleep 3
    done ) &
fi

if [ -x "$VISION_PYTHON" ]; then
  "$VISION_PYTHON" tools/vision-daemon.py --frames "$FRAMES" --out "$SCENE" $WANT_VLM \
    >>"$LOCAL/vision.log" 2>&1 &
fi

PORTAL_CAPTURE_PORT="$PORT" PORTAL_WINDOW_TITLE="$TITLE" PORTAL_WINDOW_OWNER="$APP" \
PORTAL_HEARD_FILE="$HEARD" PORTAL_SCENE_FILE="$SCENE" \
PORTAL_FRAMES_DIR="$FRAMES" PORTAL_REC_DIR="$REC" \
  python3 tools/mac-capture-daemon.py >>"$LOCAL/capture-$GAME.log" 2>&1 &

sleep 2
echo "$GAME: capture on 127.0.0.1:$PORT | frames $FRAMES | recording $REC"
echo "logs: $LOCAL/{tap,asr,vision,capture-$GAME}.log     stop: tools/start.sh stop"
