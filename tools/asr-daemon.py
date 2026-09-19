#!/usr/bin/env python3
"""Speech recognition of the game's audio for the agent ("what it heard").

Reads raw 16 kHz mono float32 PCM on stdin (from tools/game-audio-tap), splits
it into utterances, transcribes each one and appends it to a JSONL file:

  {"start": <epoch s>, "end": <epoch s>, "text": "..."}

A tiny state file ("speaking" / "transcribing" / "idle") next to it lets the
controller wait for a line that is still being spoken or transcribed.
Only game audio is used; no game files are read.

Engines:
  gigaam  (default) GigaAM v3 RNNT - best for Russian, CPU, several times
          faster than real time. Needs the gigaam package, so run this daemon
          with an interpreter that has it.
  whisper mlx-whisper on the Apple GPU, multilingual.

Segmentation: Silero VAD when available, else a level + speech-band gate
(game room tone is loud and low-pitched, dialogue is quiet: measured band
ratio ~0.35 vs ~0.62).

Usage:
  .local/bin/game-audio-tap portal2.exe | <python-with-gigaam> tools/asr-daemon.py
"""
import argparse
import json
import os
import queue
import sys
import threading
import time

import numpy as np

RATE = 16000
FRAME = 512  # 32 ms, the chunk size Silero VAD expects at 16 kHz

parser = argparse.ArgumentParser()
parser.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", ".local", "heard.jsonl"))
parser.add_argument("--engine", choices=["gigaam", "whisper"], default="gigaam")
parser.add_argument("--model", default=None, help="engine-specific model id")
parser.add_argument("--language", default=None, help="whisper only, e.g. ru; default: auto")
parser.add_argument("--vad", choices=["silero", "spectral", "auto"], default="auto")
parser.add_argument("--min-rms", type=float, default=0.009, help="spectral VAD: level threshold")
parser.add_argument("--min-band", type=float, default=0.5, help="spectral VAD: 300-3400 Hz energy share")
parser.add_argument("--speech-prob", type=float, default=0.5, help="silero VAD: speech probability")
args = parser.parse_args()

OUT = os.path.abspath(args.out)
STATE = OUT + ".state"
os.makedirs(os.path.dirname(OUT), exist_ok=True)

# Whisper's well-known outputs on silence/music, mostly subtitle credits.
HALLUCINATIONS = (
    "продолжение следует", "субтитры", "редактор субтитров", "спасибо за просмотр",
    "thank you for watching", "thanks for watching", "subtitles by", "amara.org", "dimatorzok",
)


def log(msg):
    print(f"[asr] {msg}", file=sys.stderr, flush=True)


state_lock = threading.Lock()
state = {"speaking": False, "pending": 0}


def write_state():
    with state_lock:
        s = "speaking" if state["speaking"] else ("transcribing" if state["pending"] else "idle")
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        f.write(f"{s} {time.time():.3f}\n")
    os.replace(tmp, STATE)


jobs = queue.Queue()

# --- Engines ----------------------------------------------------------------


def make_gigaam():
    import tempfile

    import soundfile as sf
    sys.path.insert(0, os.path.expanduser("~/Projects/asr-ru-перенос/код"))
    try:  # the reference setup patches GigaAM's chunker to use Silero VAD
        import silero_seg
        silero_seg.patch()
    except Exception:
        pass
    import gigaam

    model = gigaam.load_model(args.model or "v3_e2e_rnnt", device="cpu")

    def transcribe(audio):
        with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
            sf.write(tmp.name, audio, RATE)
            result = model.transcribe(tmp.name)
            # GigaAM v3 returns a TranscriptionResult; older versions a string.
            return str(getattr(result, "text", result)).strip()

    return transcribe


def make_whisper():
    import mlx_whisper

    model = args.model or "mlx-community/whisper-large-v3-turbo"
    mlx_whisper.transcribe(np.zeros(RATE, dtype=np.float32), path_or_hf_repo=model, language=args.language or "ru")

    def transcribe(audio):
        result = mlx_whisper.transcribe(
            audio, path_or_hf_repo=model, language=args.language,
            condition_on_previous_text=False, temperature=0.0,
        )
        segs = [s for s in result.get("segments", []) if s.get("no_speech_prob", 0) < 0.6]
        return " ".join(s["text"].strip() for s in segs).strip()

    return transcribe


def transcriber():
    transcribe = make_gigaam() if args.engine == "gigaam" else make_whisper()
    log(f"engine ready: {args.engine}")
    while True:
        audio, start, end = jobs.get()
        try:
            # Dialogue can sit just above room tone; normalize to full scale.
            peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
            if peak > 1e-4:
                audio = (audio / peak * 0.9).astype(np.float32)
            text = transcribe(audio)
            if text and not any(h in text.lower() for h in HALLUCINATIONS):
                with open(OUT, "a", encoding="utf-8") as f:
                    f.write(json.dumps({"start": round(start, 3), "end": round(end, 3), "text": text}, ensure_ascii=False) + "\n")
                log(f"{end - start:4.1f}s  {text}")
        except Exception as e:  # keep listening even if one line fails
            log(f"transcription failed: {e}")
        finally:
            with state_lock:
                state["pending"] -= 1
            write_state()
            jobs.task_done()


threading.Thread(target=transcriber, daemon=True).start()

# --- Voice activity detection -----------------------------------------------

WINDOW = np.hanning(FRAME).astype(np.float32)
FREQS = np.fft.rfftfreq(FRAME, 1 / RATE)
BAND = (FREQS > 300) & (FREQS < 3400)
noise = 0.005  # running noise-floor estimate, spectral VAD only


def spectral_is_speech(frame):
    global noise
    rms = float(np.sqrt(np.mean(frame * frame)))
    threshold = max(args.min_rms, noise * 1.8)
    power = np.abs(np.fft.rfft(frame * WINDOW)) ** 2
    total = float(power.sum())
    band = float(power[BAND].sum()) / total if total > 1e-12 else 0.0
    speech = rms > threshold and band > args.min_band
    if not speech:
        noise = 0.995 * noise + 0.005 * rms
    return speech


def make_silero():
    import torch
    from silero_vad import load_silero_vad
    model = load_silero_vad()

    def is_speech(frame):
        with torch.no_grad():
            return float(model(torch.from_numpy(frame.copy()), RATE).item()) > args.speech_prob

    return is_speech


is_speech = None
if args.vad in ("silero", "auto"):
    try:
        is_speech = make_silero()
        log("vad: silero")
    except Exception as e:
        if args.vad == "silero":
            raise
        log(f"vad: spectral (silero unavailable: {e})")
if is_speech is None:
    is_speech = spectral_is_speech

START_FRAMES = 4    # ~128 ms of speech starts an utterance
END_FRAMES = 24     # ~770 ms of silence ends it
PAD_FRAMES = 10     # keep ~320 ms before the start
MAX_SECONDS = 25

ring = []
utter = None
utter_start = 0.0
above = below = 0
write_state()
log(f"listening; writing {OUT}")

stdin = sys.stdin.buffer
while True:
    raw = stdin.read(FRAME * 4)
    if not raw or len(raw) < FRAME * 4:
        break
    frame = np.frombuffer(raw, dtype=np.float32)
    now = time.time()
    speech = is_speech(frame)

    if utter is None:
        ring.append(frame)
        ring = ring[-PAD_FRAMES:]
        above = above + 1 if speech else 0
        if above >= START_FRAMES:
            utter = list(ring)
            utter_start = now - len(utter) * FRAME / RATE
            below = 0
            with state_lock:
                state["speaking"] = True
            write_state()
    else:
        utter.append(frame)
        below = 0 if speech else below + 1
        too_long = len(utter) * FRAME / RATE > MAX_SECONDS
        if below >= END_FRAMES or too_long:
            audio = np.concatenate(utter if too_long else utter[: -below or None])
            with state_lock:
                state["speaking"] = False
                state["pending"] += 1
            write_state()
            jobs.put((audio, utter_start, now))
            utter, ring, above = None, [], 0

# stdin closed (audio tap stopped): finish the utterance in flight, then drain.
if utter:
    with state_lock:
        state["speaking"] = False
        state["pending"] += 1
    jobs.put((np.concatenate(utter), utter_start, time.time()))
jobs.join()
write_state()
log("audio stream ended")
