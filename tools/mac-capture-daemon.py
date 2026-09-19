#!/usr/bin/env python3
"""macOS window-capture sidecar for the Portal MCP server.

Under CrossOver/Wine, SPT's ReadPixels returns an all-black backbuffer, so the
controller still uses SPT to sync to a rendered frame and then asks this
daemon for the actual pixels of the "Portal - Direct3D 9" window.

It runs outside the MCP sandbox (it needs child processes and Screen
Recording permission), so the sandboxed broker only gets a loopback socket to
it, never a way to spawn processes.

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


def capture(src_w, src_h, target_w, target_h):
    global _window_id
    try:
        if _window_id is None:
            _window_id = find_window_id()
        img = capture_window(_window_id)
    except Exception:
        # The game may have restarted and got a new window id.
        _window_id = find_window_id()
        img = capture_window(_window_id)

    # The window image includes the title bar on top. The client area is the
    # bottom part with the backbuffer's aspect ratio.
    w, h = img.size
    client_h = min(h, round(w * src_h / src_w))
    img = img.crop((0, h - client_h, w, h))
    if img.size != (target_w, target_h):
        img = img.resize((target_w, target_h), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=JPEG_QUALITY)
    return buf.getvalue(), target_w, target_h


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            parts = self.rfile.readline(256).decode("ascii").split()
            if parts and parts[0] == "HEARD":
                new_offset, state, lines = heard_since(int(parts[1]))
                body = json.dumps(lines, ensure_ascii=False).encode("utf-8")
                self.wfile.write(f"HEARD {new_offset} {state} {len(body)}\n".encode("ascii") + body)
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
        print(f"[capture] serving {WINDOW_TITLE!r} on {HOST}:{PORT}", file=sys.stderr, flush=True)
        srv.serve_forever()
