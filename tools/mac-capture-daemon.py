#!/usr/bin/env python3
"""macOS window-capture sidecar for the Portal MCP server.

Under CrossOver/Wine, SPT's ReadPixels returns an all-black backbuffer, so the
controller still uses SPT to sync to a rendered frame and then asks this
daemon for the actual pixels of the "Portal - Direct3D 9" window.

It runs outside the MCP sandbox (it needs child processes and Screen
Recording permission), so the sandboxed broker only gets a loopback socket to
it, never a way to spawn processes.

Frames come from tools/game-tap when it is running (frames/latest.jpg, a few
per second): that avoids spawning `screencapture` (~120 ms) per shot. It also
serves any past moment out of game-tap's recorded segments ("rewind"):
  request:  "FRAME <epoch_ms> <target_w> <target_h>\n"
  response: same "OK <len> <w> <h>" shape as a screenshot.

Portal 2 throttles itself heavily when its window is not focused (measured:
12 vs 34 simulation ticks per second), so the controller asks for the game to
be brought to the front before it plays a plan:
  request:  "FOCUS\n"      response: "OK 0 0 0\n"

It also serves what the agent heard, from tools/asr-daemon.py's transcript
(speech recognition of the game audio; no game files are read):
  request:  "HEARD <offset>\n"  (byte offset into the transcript JSONL)
  response: "HEARD <new_offset> <state> <len>\n" + JSON array of
            {"start","end","text"}; state is speaking/transcribing/idle.

Protocol (one request per connection, 127.0.0.1 only):
  request:  "<src_w> <src_h> <target_w> <target_h>\n"
            src_* is the SPT backbuffer size (used for the client-area aspect),
            target_* is the output size.
  response: "OK <len> <w> <h>\n" + JPEG bytes, or "ERR <message>\n".
"""
import io
import json
import subprocess
import time
import os
import socketserver
import subprocess
import sys
import tempfile

from PIL import Image

HOST = "127.0.0.1"
PORT = int(os.environ.get("PORTAL_CAPTURE_PORT", "27183"))
WINDOW_TITLE = os.environ.get("PORTAL_WINDOW_TITLE", "Portal - Direct3D 9")
WINDOW_OWNER = os.environ.get("PORTAL_WINDOW_OWNER", "hl2.exe")
JPEG_QUALITY = 85
HEARD_FILE = os.environ.get("PORTAL_HEARD_FILE")
SCENE_FILE = os.environ.get("PORTAL_SCENE_FILE")
FRAMES_DIR = os.environ.get("PORTAL_FRAMES_DIR")
REC_DIR = os.environ.get("PORTAL_REC_DIR")
FRAME_MAX_AGE = float(os.environ.get("PORTAL_FRAME_MAX_AGE", "1.0"))


def jsonl_since(path, offset, state_suffix=".state"):
    """Tail a JSONL file from a byte offset; returns (new_offset, state, rows)."""
    state = "off"
    if path:
        try:
            with open(path + state_suffix) as f:
                state = f.read().split()[0]
        except (OSError, IndexError):
            state = "idle"
    if not path:
        return offset, state, []
    try:
        size = os.path.getsize(path)
    except OSError:
        return 0, state, []
    if offset > size:
        offset = 0
    with open(path, "rb") as f:
        f.seek(offset)
        chunk = f.read(size - offset)
    end = chunk.rfind(b"\n") + 1
    rows = [json.loads(l) for l in chunk[:end].decode("utf-8").splitlines() if l.strip()]
    return offset + end, state, rows


def live_frame():
    """The newest frame written by game-tap, if it is fresh enough."""
    if not FRAMES_DIR:
        return None
    path = os.path.join(FRAMES_DIR, "latest.jpg")
    try:
        if time.time() - os.path.getmtime(path) > FRAME_MAX_AGE:
            return None
        return Image.open(path).convert("RGB")
    except (OSError, ValueError):
        return None


def recorded_frame(epoch_ms):
    """A frame from a recorded segment: the rewind path."""
    if not REC_DIR:
        raise RuntimeError("PORTAL_REC_DIR is not set (game-tap --record)")
    segments = sorted(int(f[:-4]) for f in os.listdir(REC_DIR) if f.endswith(".mp4"))
    earlier = [s for s in segments if s <= epoch_ms]
    if not earlier:
        raise RuntimeError("no recording covers that moment")
    start = earlier[-1]
    with tempfile.NamedTemporaryFile(suffix=".jpg") as tmp:
        res = subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", f"{(epoch_ms - start) / 1000:.2f}",
             "-i", os.path.join(REC_DIR, f"{start}.mp4"), "-frames:v", "1", "-y", tmp.name],
            capture_output=True, timeout=20)
        if res.returncode != 0 or os.path.getsize(tmp.name) == 0:
            raise RuntimeError("that moment is not in the recording yet")
        return Image.open(tmp.name).convert("RGB")


def focus_game():
    """Bring the game window to the front: it runs ~3x faster when focused."""
    script = f'tell application "System Events" to set frontmost of (first process whose name contains "{WINDOW_OWNER.split(".")[0]}") to true'
    subprocess.run(["osascript", "-e", script], capture_output=True, timeout=10)


def heard_since(offset):
    if not HEARD_FILE:
        return offset, "off", []
    try:
        with open(HEARD_FILE + ".state") as f:
            state = f.read().split()[0]
    except (OSError, IndexError):
        state = "off"
    try:
        size = os.path.getsize(HEARD_FILE)
    except OSError:
        return 0, state, []
    if offset > size:
        offset = 0
    with open(HEARD_FILE, "rb") as f:
        f.seek(offset)
        chunk = f.read(size - offset)
    # Only hand out complete lines.
    end = chunk.rfind(b"\n") + 1
    lines = [json.loads(l) for l in chunk[:end].decode("utf-8").splitlines() if l.strip()]
    return offset + end, state, lines

FIND_WINDOW_JXA = r"""
ObjC.import("CoreGraphics");
const title = %s;
const wantOwner = %s;
const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0)).js;
let found = null;
for (const w of list) {
  const d = w.js;
  const name = d.kCGWindowName ? d.kCGWindowName.js : "";
  const owner = d.kCGWindowOwnerName ? d.kCGWindowOwnerName.js : "";
  if (name === title && owner === wantOwner) { found = d.kCGWindowNumber.js; break; }
}
JSON.stringify(found);
"""

_window_id = None


def find_window_id():
    out = subprocess.run(
        ["osascript", "-l", "JavaScript", "-e", FIND_WINDOW_JXA % (json.dumps(WINDOW_TITLE), json.dumps(WINDOW_OWNER))],
        capture_output=True, text=True, timeout=10,
    )
    wid = json.loads(out.stdout.strip() or "null")
    if wid is None:
        raise RuntimeError(f'window "{WINDOW_TITLE}" not found')
    return int(wid)


def capture_window(wid):
    with tempfile.NamedTemporaryFile(suffix=".png") as tmp:
        # -l: capture this window even when occluded; -o: no shadow; -x: no sound.
        res = subprocess.run(["screencapture", "-x", "-o", "-l", str(wid), "-t", "png", tmp.name],
                             capture_output=True, timeout=10)
        if res.returncode != 0 or os.path.getsize(tmp.name) == 0:
            raise RuntimeError("screencapture failed (window gone or no Screen Recording permission)")
        return Image.open(tmp.name).convert("RGB")


def fit(img, src_w, src_h, target_w, target_h):
    """Crop the title bar (window shots only) and scale to the target size."""
    w, h = img.size
    client_h = min(h, round(w * src_h / src_w))
    if client_h < h:
        img = img.crop((0, h - client_h, w, h))
    if img.size != (target_w, target_h):
        img = img.resize((target_w, target_h), Image.LANCZOS)
    return img


def encode(img, quality=JPEG_QUALITY):
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def capture(src_w, src_h, target_w, target_h):
    global _window_id
    live = live_frame()
    if live is not None:
        # game-tap already cropped the title bar.
        img = live if live.size == (target_w, target_h) else live.resize((target_w, target_h), Image.LANCZOS)
        return encode(img), target_w, target_h
    try:
        if _window_id is None:
            _window_id = find_window_id()
        img = capture_window(_window_id)
    except Exception:
        # The game may have restarted and got a new window id.
        _window_id = find_window_id()
        img = capture_window(_window_id)

    img = fit(img, src_w, src_h, target_w, target_h)
    return encode(img), target_w, target_h


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            parts = self.rfile.readline(256).decode("ascii").split()
            if parts and parts[0] == "FOCUS":
                focus_game()
                self.wfile.write(b"OK 0 0 0\n")
                return
            if parts and parts[0] == "HEARD":
                new_offset, state, lines = heard_since(int(parts[1]))
                body = json.dumps(lines, ensure_ascii=False).encode("utf-8")
                self.wfile.write(f"HEARD {new_offset} {state} {len(body)}\n".encode("ascii") + body)
                return
            if parts and parts[0] == "SCENE":
                new_offset, state, rows = jsonl_since(SCENE_FILE, int(parts[1]))
                latest = {}
                if SCENE_FILE:
                    try:
                        latest = json.load(open(SCENE_FILE.replace(".jsonl", ".json")))
                    except (OSError, ValueError):
                        latest = {}
                body = json.dumps({"scene": latest, "events": rows}, ensure_ascii=False).encode("utf-8")
                self.wfile.write(f"SCENE {new_offset} {state} {len(body)}\n".encode("ascii") + body)
                return
            if parts and parts[0] == "FRAME":
                epoch_ms, target_w, target_h = (int(p) for p in parts[1:4])
                img = recorded_frame(epoch_ms)
                data = encode(img.resize((target_w, target_h), Image.LANCZOS))
                self.wfile.write(f"OK {len(data)} {target_w} {target_h}\n".encode("ascii") + data)
                return
            src_w, src_h, target_w, target_h = (int(p) for p in parts)
            if min(src_w, src_h, target_w, target_h) <= 0 or max(target_w, target_h) > 8192:
                raise ValueError("bad dimensions")
            data, w, h = capture(src_w, src_h, target_w, target_h)
            self.wfile.write(f"OK {len(data)} {w} {h}\n".encode("ascii") + data)
        except Exception as e:  # report instead of dropping the connection
            msg = str(e).replace("\n", " ")
            self.wfile.write(f"ERR {msg}\n".encode("utf-8"))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server((HOST, PORT), Handler) as srv:
        source = f"frames {FRAMES_DIR}" if FRAMES_DIR else f"window {WINDOW_TITLE!r}"
        print(f"[capture] serving {source} on {HOST}:{PORT}"
              + (f", rewind from {REC_DIR}" if REC_DIR else ""), file=sys.stderr, flush=True)
        srv.serve_forever()
