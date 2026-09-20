#!/usr/bin/env python3
"""Follow what the agent is doing, in a readable form.

Tails the stream-json output of a headless Claude Code run (or any transcript
JSONL) and prints one short line per event: the agent's own words, the code it
runs, and what came back - ticks, distance moved, what it heard, the scene.

Usage:
  tools/watch-agent.py [file] [--all]      # default: the Portal 2 run log
  tools/watch-agent.py --once              # print what happened so far and exit
"""
import argparse
import json
import os
import sys
import time

DEFAULT = os.path.expanduser("~/Projects/portal2-run/.local-fable.jsonl")

parser = argparse.ArgumentParser()
parser.add_argument("file", nargs="?", default=DEFAULT)
parser.add_argument("--once", action="store_true", help="do not follow the file")
parser.add_argument("--all", action="store_true", help="also show tool input in full")
args = parser.parse_args()

DIM, BOLD, BLUE, GREEN, YELLOW, RED, RESET = (
    "\033[2m", "\033[1m", "\033[34m", "\033[32m", "\033[33m", "\033[31m", "\033[0m"
)

calls = {}


def clock():
    return time.strftime("%H:%M:%S")


def one_line(text, limit=160):
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def show(line):
    try:
        event = json.loads(line)
    except ValueError:
        return
    kind = event.get("type")
    message = event.get("message") or {}

    if kind == "assistant":
        for block in message.get("content", []):
            if block.get("type") == "text" and block["text"].strip():
                print(f"{DIM}{clock()}{RESET} {BOLD}{one_line(block['text'], 200)}{RESET}")
            elif block.get("type") == "tool_use":
                name = block["name"].split("__")[-1]
                payload = block.get("input", {})
                code = payload.get("code") or payload.get("file_path") or json.dumps(payload, ensure_ascii=False)
                calls[block["id"]] = name
                print(f"{DIM}{clock()}{RESET} {BLUE}{name}{RESET} {one_line(code, 400 if args.all else 150)}")

    elif kind == "user":
        content = message.get("content")
        if not isinstance(content, list):
            return
        for block in content:
            if block.get("type") != "tool_result":
                continue
            name = calls.get(block.get("tool_use_id"), "result")
            parts = block.get("content") if isinstance(block.get("content"), list) else []
            text = " ".join(p.get("text", "") for p in parts if isinstance(p, dict))
            images = sum(1 for p in parts if isinstance(p, dict) and p.get("type") == "image")
            color = RED if block.get("is_error") else GREEN
            suffix = f" {DIM}+{images} кадр{RESET}" if images else ""
            summary = text
            try:  # the interesting fields, when the snippet returned the run result
                data = json.loads(text[text.index("{"):])
                bits = []
                for key in ("ticks", "moved", "aborted", "reason"):
                    if key in data:
                        bits.append(f"{key}={data[key]}")
                if isinstance(data.get("scene"), dict) and data["scene"].get("summary"):
                    bits.append(data["scene"]["summary"])
                elif isinstance(data.get("scene"), str):
                    bits.append(data["scene"])
                if data.get("heard"):
                    bits.append("heard: " + " | ".join(data["heard"]))
                if bits:
                    summary = "  ".join(bits)
            except (ValueError, IndexError):
                pass
            print(f"{DIM}{clock()}   ↳{RESET} {color}{one_line(summary)}{RESET}{suffix}")

    elif kind == "result":
        cost = event.get("total_cost_usd")
        print(f"{YELLOW}— сессия завершена{RESET}" + (f" (${cost:.2f})" if cost else ""))


def main():
    path = args.file
    while not os.path.exists(path):
        if args.once:
            sys.exit(f"нет файла: {path}")
        time.sleep(1)
    with open(path, encoding="utf-8") as f:
        for line in f:
            show(line)
        if args.once:
            return
        print(f"{DIM}— слежу за {path} (Ctrl-C чтобы выйти){RESET}")
        while True:
            line = f.readline()
            if line:
                show(line)
            else:
                time.sleep(0.4)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
