// The run journal: what actually happened, written by the broker rather than
// by the agent. One JSONL line per event in the run folder, so it survives
// context compaction, session restarts and a change of client, and can be
// replayed against the recorded video by timestamp.
//
// Lines look like:
//   {"t":1789854043.3,"type":"plan","code":"…","ticks":121,"moved":73.2,
//    "position":{…},"facing":{…},"heard":[…],"scene":"left near, center clear"}
//   {"t":…,"type":"note","text":"agent wrote notes.md"}

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Data-URL screenshots would swamp the journal; they live in the recording.
const imageSafe = (key, value) =>
  typeof value === "string" && value.startsWith("data:image/") ? `[image ${value.length}b]` : value;

const MAX_CODE = 600;
const MAX_TEXT = 400;

export class Journal {
  constructor(file) {
    this.file = file ? resolve(file) : null;
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
      } catch {
        this.file = null;
      }
    }
  }

  #write(entry) {
    if (!this.file) return;
    try {
      appendFileSync(this.file, JSON.stringify({ t: Date.now() / 1000, ...entry }) + "\n");
    } catch {
      // The journal is a convenience; never fail a tool call over it.
    }
  }

  // A portal_exec snippet and what it produced.
  exec(code, result) {
    const entry = { type: "exec", code: String(code).slice(0, MAX_CODE) };
    if (result && typeof result === "object") {
      let known = false;
      for (const key of ["ticks", "moved", "aborted", "reason", "position", "facing", "heard"]) {
        if (result[key] !== undefined) {
          entry[key] = result[key];
          known = true;
        }
      }
      if (result.scene?.summary) {
        entry.scene = result.scene.summary;
        known = true;
      }
      if (result.scene?.objects) entry.objects = result.scene.objects;
      if (result.sceneEvents?.length) entry.sceneEvents = result.sceneEvents.length;
      if (!known) {
        // A snippet returning its own shape: keep it verbatim, truncated. The
        // journal is meant to be readable without guessing what ran.
        try {
          entry.returned = JSON.stringify(result, imageSafe).slice(0, MAX_TEXT);
        } catch {
          entry.returned = "[unserializable]";
        }
      }
    } else if (result !== undefined) {
      entry.returned = String(result).slice(0, MAX_TEXT);
    }
    this.#write(entry);
  }

  error(code, message) {
    this.#write({ type: "error", code: String(code).slice(0, MAX_CODE), message: String(message).slice(0, MAX_TEXT) });
  }

  screenshot(width, height) {
    this.#write({ type: "screenshot", width, height });
  }

  note(text) {
    this.#write({ type: "note", text: String(text).slice(0, MAX_TEXT) });
  }
}
