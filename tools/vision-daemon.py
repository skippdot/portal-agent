#!/usr/bin/env python3
"""Continuous scene analysis of the game window, for the agent.

Watches the newest frame written by tools/game-tap (frames/latest.jpg) and
keeps an up-to-date picture of what is on screen, so the agent never has to
wait for perception:

  depth  Depth Anything V2 small via Core ML on the Neural Engine (~25 ms a
         frame, so it does not compete with the game for the GPU). Gives a
         five-direction "how close is the nearest surface" fan plus the floor
         right in front of the player.
  objects (optional, --vlm) a small local vision model names what is visible.
         It runs on the GPU, so only every --vlm-every seconds and only when
         the frame actually changed.

Writes:
  scene.json   the current scene (overwritten atomically)
  scene.jsonl  one line per change - the event timeline the agent reads

Usage:
  tools/vision-daemon.py --frames .local/frames --out .local/scene.jsonl [--vlm]
"""
import argparse
import json
import os
import threading
import time

import numpy as np
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("--frames", default=".local/frames")
parser.add_argument("--out", default=".local/scene.jsonl")
parser.add_argument("--model", default=".local/models/DepthAnythingV2SmallF16.mlpackage")
parser.add_argument("--fps", type=float, default=4.0)
parser.add_argument("--vlm", action="store_true", help="also name objects with a local vision model")
parser.add_argument("--vlm-model", default="mlx-community/Qwen2.5-VL-3B-Instruct-4bit")
parser.add_argument("--vlm-every", type=float, default=6.0, help="seconds between vision-model runs")
args = parser.parse_args()

OUT = os.path.abspath(args.out)
LATEST = OUT.replace(".jsonl", ".json")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

# Inverse depth from the model: 1.0 = surface right in front, 0.0 = far away.
BLOCKED, NEAR = 0.55, 0.35
DIRECTIONS = ["left", "left_center", "center", "right_center", "right"]


def log(msg):
    print(f"[vision] {msg}", flush=True)


def label(value):
    return "blocked" if value > BLOCKED else ("near" if value > NEAR else "clear")


class Depth:
    def __init__(self, path):
        import coremltools as ct
        self.model = ct.models.MLModel(path, compute_units=ct.ComputeUnit.CPU_AND_NE)
        spec = self.model.get_spec().description.input[0]
        self.key = spec.name
        self.size = (spec.type.imageType.width, spec.type.imageType.height)

    def __call__(self, image):
        out = self.model.predict({self.key: image.resize(self.size)})
        return np.array(out[list(out.keys())[0]]).squeeze()


def analyze_depth(depth):
    h, w = depth.shape
    band = depth[int(h * 0.42):int(h * 0.58), :]          # eye-level slice
    fan = [float(np.percentile(c, 80)) for c in np.array_split(band, 5, axis=1)]
    floor = float(np.median(depth[int(h * 0.80):, :]))    # ground right ahead
    return {
        "fan": {d: round(v, 2) for d, v in zip(DIRECTIONS, fan)},
        "blocked": [d for d, v in zip(DIRECTIONS, fan) if v > BLOCKED],
        "floor": round(floor, 2),
        "summary": ", ".join(f"{d} {label(v)}" for d, v in zip(DIRECTIONS, fan)),
    }


class Objects:
    """Small local vision model naming what is on screen. GPU, so used sparingly."""

    PROMPT = ("Name what is visible in this Portal 2 screenshot. One short item per line as "
              "'<thing> <left|center|right> <near|far>'. Only things you actually see, max 6 lines, no prose.")

    def __init__(self, model_id):
        from mlx_vlm import load
        from mlx_vlm.utils import load_config
        self.model, self.processor = load(model_id)
        self.config = load_config(model_id)
        self.model_id = model_id

    def __call__(self, path):
        from mlx_vlm import generate
        from mlx_vlm.prompt_utils import apply_chat_template
        formatted = apply_chat_template(self.processor, self.config, self.PROMPT, num_images=1)
        out = generate(self.model, self.processor, formatted, [path], max_tokens=70, verbose=False)
        text = out.text if hasattr(out, "text") else str(out)
        items, seen = [], set()
        for line in text.splitlines():
            item = line.strip().strip("-*0123456789. '\"")
            if item and item.lower() not in seen:
                seen.add(item.lower())
                items.append(item)
        return items[:6]


def write_atomic(path, payload):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp, path)


def append_event(payload):
    with open(OUT, "a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")


def main():
    frames = os.path.abspath(args.frames)
    latest_jpg = os.path.join(frames, "latest.jpg")
    latest_meta = os.path.join(frames, "latest.json")

    depth = Depth(os.path.abspath(args.model))
    log(f"depth ready ({depth.size[0]}x{depth.size[1]}, Neural Engine)")

    objects = None
    object_items = []
    object_lock = threading.Lock()
    if args.vlm:
        def load_vlm():
            nonlocal objects
            objects = Objects(args.vlm_model)
            log(f"objects ready ({args.vlm_model})")
        threading.Thread(target=load_vlm, daemon=True).start()

    interval = 1.0 / max(0.5, args.fps)
    last_mtime = 0.0
    last_small = None
    last_scene = None
    last_vlm = 0.0
    vlm_busy = False

    log(f"watching {latest_jpg}")
    while True:
        time.sleep(interval)
        try:
            mtime = os.path.getmtime(latest_jpg)
        except OSError:
            continue
        if mtime == last_mtime:
            continue
        last_mtime = mtime
        try:
            image = Image.open(latest_jpg).convert("RGB")
        except Exception:
            continue
        try:
            frame_t = json.load(open(latest_meta))["t"] / 1000
        except Exception:
            frame_t = mtime

        small = np.asarray(image.resize((64, 40)).convert("L"), dtype=np.float32)
        change = 0.0 if last_small is None else float(np.abs(small - last_small).mean())
        last_small = small

        scene = analyze_depth(depth(image))
        scene["t"] = round(frame_t, 3)
        scene["change"] = round(change, 2)

        # Run once as soon as the model is ready, then only on real change:
        # while the world is frozen the frame does not move at all.
        first_run = objects is not None and not object_items
        if objects is not None and not vlm_busy and (first_run or change > 2.0) \
                and time.time() - last_vlm > args.vlm_every:
            last_vlm = time.time()
            vlm_busy = True

            def run_objects(path=latest_jpg):
                nonlocal vlm_busy
                try:
                    items = objects(path)
                    with object_lock:
                        object_items[:] = items
                except Exception as e:
                    log(f"objects failed: {e}")
                finally:
                    vlm_busy = False

            threading.Thread(target=run_objects, daemon=True).start()

        with object_lock:
            if object_items:
                scene["objects"] = list(object_items)

        write_atomic(LATEST, scene)

        # An event is worth recording when the view changed materially or a
        # direction flipped between clear and blocked.
        flipped = last_scene and any(
            label(scene["fan"][d]) != label(last_scene["fan"][d]) for d in DIRECTIONS
        )
        if last_scene is None or flipped or change > 6.0:
            append_event(scene)
            last_scene = scene


if __name__ == "__main__":
    main()
