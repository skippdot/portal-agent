// Portal 2 backend: drives SourceAutoRecord (SAR) through its TAS protocol
// server (`sar_tas_protocol_server 6555`) and exposes the same client
// interface as SptCommandClient in ../index.mjs, so PortalController and the
// agent-facing `portal` API are shared between Portal and Portal 2.
//
// Each tasRun() becomes one .p2tas script played with `start now` from the
// current state. The script ends with a long idle tail and SAR's pause tick
// (`sar_tas_pauseat`) freezes the world right after the plan: when a script
// actually ends, SAR's Stop() un-freezes the world. On the plan's final tick
// the script captures `sar_geteyepos` into an svar and sends it back as a
// protocol text message, which is how the view angles are read (the player
// entity's abs_angles only carry a stale body yaw).
//
// Protocol reference: SourceAutoRecord docs/tas_proto.txt and
// src/Features/Tas/TasProtocol.cpp. Integers/floats are big-endian; strings
// are a u32 length followed by bytes.

import net from "node:net";
import {
  normalizeTasSteps,
  captureFromSidecar,
  fit360p,
  toDataUrl,
  emitImage,
} from "../index.mjs";

export const P2_TICKS_PER_SECOND = 60;

const SEND = { PLAY: 0, STOP: 1, RATE: 2, RESUME: 3, PAUSE: 4, FF: 5, PAUSE_AT: 6, ADVANCE: 7, MESSAGE: 8, PLAY_RAW: 10, ENTITY: 100 };
const RECV = { ACTIVE: 0, INACTIVE: 1, RATE: 2, PLAYING: 3, PAUSED: 4, FF: 5, TICK: 6, DEBUG_TICK: 7, MESSAGE: 8, PROCESSED: 10, ENTITY: 100, GAME_DIR: 255 };

// Idle ticks appended after every plan so the script never reaches its end
// (which would un-freeze the world) before the pause tick fires.
const IDLE_TAIL_TICKS = 3600;
const EYE_MESSAGE_RE = /eye:\s*(\S+)\s+(\S+)\s+(\S+)\s*angles:\s*(\S+)\s+(\S+)\s+(\S+)/;
// Console commands run on every plan's first tick: keep the physical mouse
// from nudging the view and keep closed captions on screen (the agent reads
// them from screenshots; game files are never read).
const PLAN_PREFIX_COMMANDS = ["cl_mouseenable 0", "closecaption 1", "cc_subtitles 0"].join(";");
const REPORT_COMMANDS = 'svar_capture __agent_eye sar_geteyepos;sar_expand sar_tas_protocol_send_msg "$__agent_eye"';

const round2 = (v) => Math.round(v * 100) / 100;
const fmt = (v) => String(Math.round(v * 1000) / 1000);

function encodeString(text) {
  const bytes = Buffer.from(text, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length);
  return Buffer.concat([len, bytes]);
}

function encodeU32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function packet(id, ...parts) {
  return Buffer.concat([Buffer.from([id]), ...parts]);
}

// --- Script compilation -----------------------------------------------------

function movementOf(keys = {}) {
  const x = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const y = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  return `${x} ${y}`;
}

function buttonsOf(keys = {}) {
  return [
    ["J", keys.jump], ["D", keys.duck], ["U", keys.use], ["Z", false], ["B", keys.attack], ["O", keys.attack2],
  ].map(([letter, on]) => (on ? letter : letter.toLowerCase())).join("");
}

// Compile normalized TAS steps into a .p2tas script. `facing` is the view at
// the start of the plan; absolute targets (pitch_to/yaw_to) become `setang`,
// relative deltas become a one-tick camera rotation (SAR camera: horizontal
// degrees to the right, vertical degrees up; Source: yaw > 0 left, pitch > 0
// down). Returns the script and the tick after the plan's last tick.
export function compileP2Script(steps, prefixCommands = PLAN_PREFIX_COMMANDS, start = "now") {
  const lines = ["version 7", `start ${start}`];
  let tick = 1;
  steps.forEach((step, index) => {
    const move = movementOf(step.keys);
    const buttons = buttonsOf(step.keys);
    const commands = [index === 0 ? prefixCommands : "", step.commands ?? ""].filter(Boolean).join(";");
    const hasAbs = step.pitch_to !== undefined || step.yaw_to !== undefined;
    const hasRel = (step.pitch ?? 0) !== 0 || (step.yaw ?? 0) !== 0;
    let camera = "0 0";
    let tools = "";
    if (hasAbs) {
      // setang needs both angles; keep the missing one via a relative-free
      // absolute: SAR's `setang` does not accept partial angles, so an
      // unspecified axis is re-read at run time by the caller (see tasRun).
      tools = `setang ${fmt(step.pitch_to)} ${fmt(step.yaw_to)}`;
    }
    if (hasRel) {
      camera = `${fmt(-(step.yaw ?? 0))} ${fmt(-(step.pitch ?? 0))}`;
    }
    lines.push(`${tick}>${move}|${camera}|${buttons}|${commands}|${tools}`);
    if (hasRel && step.ticks > 1) {
      lines.push(`${tick + 1}>${move}|0 0|${buttons}||`);
    }
    tick += step.ticks;
  });
  const endTick = tick;
  lines.push(`${endTick}>0 0|0 0|jduzbo|${REPORT_COMMANDS}|`);
  lines.push(`${endTick + IDLE_TAIL_TICKS}>0 0|0 0|jduzbo||`);
  return { script: lines.join("\n") + "\n", endTick };
}

// --- Client -----------------------------------------------------------------

export class SarTasClient {
  constructor(options = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 6555;
    this.capturePort = options.capturePort ?? null;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 2000;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.listeners = new Set();
    this.facing = null;         // last known view angles { pitch, yaw, roll }
    this.eye = null;            // last known eye position
    this.state = { active: false, paused: false, tick: null };
    this.busy = false;
    this.planCount = 0;
    this.heardOffset = null;    // cursor into the speech-recognition transcript
  }

  // Speech recognition of the game audio (tools/asr-daemon.py), served by the
  // capture sidecar. Returns lines recognized since the last call; if speech
  // is still being spoken or transcribed, waits up to `waitMs` for it.
  async heard(waitMs = 8000) {
    if (!this.capturePort) return [];
    const deadline = Date.now() + waitMs;
    const texts = [];
    for (;;) {
      const { offset, state, lines } = await this.#heardRequest(this.heardOffset ?? 0);
      if (this.heardOffset === null) {
        // First call: start from "now", not from old transcripts.
        this.heardOffset = offset;
        return [];
      }
      this.heardOffset = offset;
      for (const line of lines) texts.push(line.text);
      if ((state !== "speaking" && state !== "transcribing") || Date.now() >= deadline) return texts;
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  #heardRequest(offset) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.capturePort });
      const chunks = [];
      socket.setTimeout(5000, () => socket.destroy(new Error("heard request timed out")));
      socket.on("connect", () => socket.write(`HEARD ${offset}\n`));
      socket.on("data", (c) => chunks.push(c));
      socket.on("error", reject);
      socket.on("end", () => {
        const data = Buffer.concat(chunks);
        const nl = data.indexOf(0x0a);
        const [tag, newOffset, state] = data.subarray(0, nl).toString().split(" ");
        if (tag !== "HEARD") return reject(new Error(`heard request failed: ${data.subarray(0, nl)}`));
        resolve({ offset: Number(newOffset), state, lines: JSON.parse(data.subarray(nl + 1).toString("utf8") || "[]") });
      });
    });
  }

  connect() {
    if (this.socket) return Promise.resolve(this);
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`SAR TAS server not reachable on ${this.host}:${this.port}. In Portal 2 run: plugin_load sar; sar_tas_protocol_server ${this.port}`));
      }, this.connectTimeoutMs);
      socket.on("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve(this);
      });
      socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.#parse();
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        this.#emit({ type: "error", error });
        reject(error);
      });
      socket.on("close", () => {
        this.socket = null;
        this.#emit({ type: "error", error: new Error("SAR TAS connection closed.") });
      });
    });
  }

  close() {
    this.socket?.end();
    this.socket = null;
  }

  #emit(event) {
    for (const listener of Array.from(this.listeners)) listener(event);
  }

  #parse() {
    for (;;) {
      const b = this.buffer;
      if (b.length === 0) return;
      const id = b[0];
      let size;
      let event;
      const str = (at) => {
        if (b.length < at + 4) return null;
        const len = b.readUInt32BE(at);
        if (b.length < at + 4 + len) return null;
        return { text: b.toString("utf8", at + 4, at + 4 + len), end: at + 4 + len };
      };
      switch (id) {
        case RECV.GAME_DIR:
        case RECV.MESSAGE: {
          const s = str(1);
          if (!s) return;
          size = s.end;
          event = { type: id === RECV.MESSAGE ? "message" : "gamedir", text: s.text };
          break;
        }
        case RECV.ACTIVE: {
          const a = str(1);
          if (!a) return;
          const c = str(a.end);
          if (!c) return;
          size = c.end;
          this.state.active = true;
          event = { type: "active" };
          break;
        }
        case RECV.INACTIVE:
          size = 1;
          this.state = { active: false, paused: false, tick: null };
          event = { type: "inactive" };
          break;
        case RECV.PLAYING:
        case RECV.FF:
          size = 1;
          this.state.paused = false;
          event = { type: "playing" };
          break;
        case RECV.PAUSED:
          size = 1;
          this.state.paused = true;
          event = { type: "paused" };
          break;
        case RECV.RATE:
          if (b.length < 5) return;
          size = 5;
          event = { type: "rate" };
          break;
        case RECV.TICK:
        case RECV.DEBUG_TICK:
          if (b.length < 5) return;
          size = 5;
          if (id === RECV.TICK) this.state.tick = b.readInt32BE(1);
          event = { type: id === RECV.TICK ? "tick" : "debugtick", tick: b.readInt32BE(1) };
          break;
        case RECV.PROCESSED: {
          const s = str(2);
          if (!s) return;
          size = s.end;
          event = { type: "processed" };
          break;
        }
        case RECV.ENTITY:
          if (b.length < 2) return;
          if (b[1] === 0) {
            size = 2;
            event = { type: "entity", found: false };
          } else {
            if (b.length < 38) return;
            const f = (k) => b.readFloatBE(2 + 4 * k);
            size = 38;
            event = {
              type: "entity", found: true,
              position: { x: f(0), y: f(1), z: f(2) },
              velocity: { x: f(6), y: f(7), z: f(8) },
            };
          }
          break;
        default:
          // Unknown packet: drop the buffer rather than desynchronize silently.
          this.buffer = Buffer.alloc(0);
          this.#emit({ type: "error", error: new Error(`Unknown SAR packet id ${id}.`) });
          return;
      }
      this.buffer = b.subarray(size);
      if (event.type === "message") this.#maybeEye(event.text);
      this.#emit(event);
    }
  }

  #maybeEye(text) {
    const m = EYE_MESSAGE_RE.exec(text);
    if (!m) return;
    const [ex, ey, ez, pitch, yaw, roll] = m.slice(1).map(Number);
    this.eye = { x: ex, y: ey, z: ez };
    this.facing = { pitch: round2(pitch), yaw: round2(yaw), roll: round2(roll) };
  }

  #send(buf) {
    if (!this.socket) throw new Error("SAR TAS connection is not open.");
    this.socket.write(buf);
  }

  #waitFor(predicate, timeoutMs, description) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`Timed out waiting for ${description}.`));
      }, timeoutMs);
      const listener = (event) => {
        if (event.type === "error") {
          clearTimeout(timer);
          this.listeners.delete(listener);
          reject(event.error);
          return;
        }
        if (predicate(event)) {
          clearTimeout(timer);
          this.listeners.delete(listener);
          resolve(event);
        }
      };
      this.listeners.add(listener);
    });
  }

  async #entity() {
    const wait = this.#waitFor((e) => e.type === "entity", 5000, "SAR entity info");
    this.#send(packet(SEND.ENTITY, encodeString("player")));
    const e = await wait;
    if (!e.found) throw new Error("Player entity not found (is a map loaded?).");
    return e;
  }

  // Plays steps as one script and resolves once SAR has paused after the plan
  // and reported the eye angles.
  async #play(steps, timeoutMs, start = "now") {
    if (this.busy) throw new Error("Another TAS plan is still running.");
    this.busy = true;
    try {
      const { script, endTick } = compileP2Script(steps, PLAN_PREFIX_COMMANDS, start);
      const name = `agent_plan_${++this.planCount}`;
      let gotEye = false;
      let paused = false;
      const done = this.#waitFor((e) => {
        if (e.type === "message" && EYE_MESSAGE_RE.test(e.text)) gotEye = true;
        if (e.type === "paused") paused = true;
        return gotEye && paused;
      }, timeoutMs, "the TAS plan to finish");
      this.#send(packet(SEND.PAUSE_AT, encodeU32(endTick + 1)));
      this.#send(packet(SEND.PLAY_RAW, encodeString(name), encodeString(script), encodeString(""), encodeString("")));
      await done;
      return endTick - 1;
    } finally {
      this.busy = false;
    }
  }

  // Absolute targets need both angles for `setang`; fill a missing axis from
  // the view the step starts with (tracked through the plan).
  async #resolveAngles(steps) {
    if (!steps.some((s) => (s.pitch_to === undefined) !== (s.yaw_to === undefined))) return steps;
    if (!this.facing) await this.#probeFacing();
    let pitch = this.facing.pitch;
    let yaw = this.facing.yaw;
    return steps.map((s) => {
      const out = { ...s };
      if (s.pitch_to !== undefined || s.yaw_to !== undefined) {
        out.pitch_to = s.pitch_to ?? pitch;
        out.yaw_to = s.yaw_to ?? yaw;
        pitch = out.pitch_to;
        yaw = out.yaw_to;
      }
      pitch += s.pitch ?? 0;
      yaw += s.yaw ?? 0;
      return out;
    });
  }

  async #probeFacing() {
    await this.#play([{ ticks: 1 }], 15000);
  }

  // Run console commands in-game. Internal: never exposed through the agent's
  // `portal` API, which must not be able to run arbitrary console commands.
  async runCommands(commands, ticks = 30) {
    await this.#play([{ ticks: 1, commands }, { ticks }], 60000);
  }

  // --- Saves (Portal 2 only) ---

  static saveName(name) {
    const clean = String(name ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(clean)) {
      throw new Error("Save names use 1-40 letters, digits, _ or -.");
    }
    return `agent_${clean}`;
  }

  // Quick-save the current state under `name` (one tick of game time).
  async saveGame(name) {
    const file = SarTasClient.saveName(name);
    // The engine writes the save over the next frames, so let the plan run on.
    await this.#play([{ ticks: 1, commands: `save ${file}` }, { ticks: 120 }], 120000);
    return { saved: name };
  }

  // Load a save made with saveGame and freeze on its first ticks.
  async loadGame(name) {
    const file = SarTasClient.saveName(name);
    if (this.heardOffset === null) await this.heard(0).catch(() => {});
    await this.#play([{ ticks: 2 }], 180000, `save ${file}`);
    this.heardOffset = null; // speech before the load is stale
    await this.heard(0).catch(() => {});
    const e = await this.#entity();
    return {
      loaded: name,
      facing: this.facing ? { ...this.facing } : undefined,
      position: { x: round2(e.position.x), y: round2(e.position.y), z: round2(e.position.z) },
    };
  }

  // --- SptCommandClient-compatible interface ---

  async tasRun(steps, options = {}) {
    const normalized = await this.#resolveAngles(normalizeTasSteps(steps));
    const totalTicks = normalized.reduce((sum, s) => sum + s.ticks, 0);
    // Under Wine the game can run well below real time, so allow 4x + 30 s.
    const timeoutMs = options.timeoutMs ?? Math.ceil((totalTicks / P2_TICKS_PER_SECOND) * 1000 * 4) + 30000;
    if (this.heardOffset === null) await this.heard(0).catch(() => {});
    const before = (options.position ?? true) ? await this.#entity().catch(() => null) : null;
    const ticks = await this.#play(normalized, timeoutMs);
    const result = { ticks };
    const heard = await this.heard().catch(() => []);
    if (heard.length) result.heard = heard;
    if (this.facing) result.facing = { ...this.facing };
    if (options.position ?? true) {
      const e = await this.#entity();
      result.position = { x: round2(e.position.x), y: round2(e.position.y), z: round2(e.position.z) };
      if (before) {
        // How far the player actually got: much less than expected means
        // something (furniture, a wall) blocked the plan.
        const d = ["x", "y", "z"].map((k) => e.position[k] - before.position[k]);
        result.moved = round2(Math.hypot(...d));
      }
    }
    return result;
  }

  async tasAbort() {
    if (!this.busy) throw new Error("No TAS plan is active.");
    this.#send(packet(SEND.PAUSE));
  }

  async observe(fields = ["facing", "position"]) {
    const out = {};
    if (fields.includes("facing")) {
      if (!this.facing) await this.#probeFacing();
      out.facing = { ...this.facing };
    }
    if (fields.includes("position")) {
      const e = await this.#entity();
      out.position = { x: round2(e.position.x), y: round2(e.position.y), z: round2(e.position.z) };
    }
    return out;
  }

  // Relative view turn. SAR cannot turn the view while frozen, so this plays a
  // one-tick plan (1/60 s of game time passes).
  async lookDelta({ pitch = 0, yaw = 0 }) {
    await this.#play([{ ticks: 1, pitch, yaw }], 15000);
    return { facing: this.facing ? { ...this.facing } : undefined };
  }

  async screenshot(options = {}) {
    if (!this.capturePort) throw new Error("Screenshots need the macOS capture sidecar (PORTAL_CAPTURE_PORT).");
    // The client area is captured at the window's own size; 960x600 is only
    // the aspect used to crop the title bar (Portal 2 windowed default 16:10).
    const source = { width: options.sourceWidth ?? 960, height: options.sourceHeight ?? 600 };
    const target = options.fullRes === true ? source : fit360p(source.width, source.height);
    const captured = await captureFromSidecar(this.host, this.capturePort, source, target);
    const result = {
      screenshots: [{ height: captured.height, url: toDataUrl(captured.bytes, "image/jpeg"), width: captured.width }],
    };
    if (options.autoEmit ?? true) {
      for (const shot of result.screenshots) await emitImage(shot.url);
    }
    return result;
  }
}
