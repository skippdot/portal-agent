#!/usr/bin/env node
// Livestream overlay for a Claude Code Portal run.
//
// Tails the Claude Code session transcript (JSONL) of the run folder, the
// speedrun demo folder (one .dem per map => splits), and proxies live game
// frames from tools/mac-capture-daemon.py. Serves overlay/index.html plus
// /state.json and /game.jpg on http://127.0.0.1:8787 — add it to OBS as a
// 1920x1080 Browser Source, or just open it in a browser.
//
// Usage: node overlay/server.mjs [--run-dir DIR] [--demo-root DIR] [--port N]

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith("--") ? [...acc, [v.slice(2), a[i + 1]]] : acc), []),
);
const GAME = args.game ?? "portal2";
const RUN_DIR = path.resolve(args["run-dir"] ?? path.join(os.homedir(), `Projects/${GAME === "portal" ? "portal-run" : "portal2-run"}`));
const JOURNAL = path.join(RUN_DIR, "journal.jsonl");
const DEMO_ROOT = args["demo-root"] ??
  path.join(os.homedir(), "Library/Application Support/CrossOver/Bottles/portal-1/drive_c/Games/Portal + Portal Prelude/portal/agent_runs");
const PORT = Number(args.port ?? 8787);
const CAPTURE_PORT = Number(args["capture-port"] ?? (GAME === "portal" ? 27183 : 27184));
const GAME_W = 960, GAME_H = 600; // SPT backbuffer size, used for the client-area crop
const TICKRATE = 66.666667;

// Claude Fable 5.1, $ per 1M tokens (Anthropic first-party API rates).
const PRICE = { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 };
const CONTEXT_WINDOW = 1_000_000;

// Portal chambers in order, with the split labels speedrunners use.
const MAPS = [
  ["testchmb_a_00", "00/01"], ["testchmb_a_01", "02/03"], ["testchmb_a_02", "04/05"],
  ["testchmb_a_03", "06/07"], ["testchmb_a_04", "08"], ["testchmb_a_05", "09"],
  ["testchmb_a_06", "10"], ["testchmb_a_07", "11/12"], ["testchmb_a_08", "13"],
  ["testchmb_a_09", "14"], ["testchmb_a_10", "15"], ["testchmb_a_11", "16"],
  ["testchmb_a_13", "17"], ["testchmb_a_14", "18"], ["testchmb_a_15", "19"],
  ["escape_00", "e00"], ["escape_01", "e01"], ["escape_02", "e02"],
];

// --- Transcript -------------------------------------------------------------

const projectDir = path.join(os.homedir(), ".claude/projects", RUN_DIR.replace(/[^A-Za-z0-9]/g, "-"));

function latestTranscript() {
  try {
    return fs.readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(projectDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
  } catch {
    return null;
  }
}

function freshState(file) {
  return {
    file, offset: 0, partial: "",
    startedAt: null, lastEventAt: null,
    usageById: new Map(),      // message.id -> usage (every content block repeats it)
    lastContext: 0,
    toolNames: new Map(),      // tool_use_id -> { name, code, at }
    toolCalls: 0,
    callTimes: [],             // ms timestamps of portal tool calls
    execTicks: [],             // { at, ticks } from portal_exec results
    trace: [],                 // { at, text }
    actions: [],               // { at, code, result }
    agentView: null, agentViewAt: null,
    status: "IDLE",
  };
}

let T = freshState(latestTranscript());

function summarizeResult(content) {
  const text = (Array.isArray(content) ? content : [{ type: "text", text: String(content) }])
    .filter((b) => b.type === "text").map((b) => b.text).join(" ");
  try {
    return JSON.stringify(JSON.parse(text)).replace(/"(\w+)":/g, '"$1": ').replace(/,"/g, ', "');
  } catch {
    return text.replace(/\s+/g, " ");
  }
}

function ingest(line) {
  let d;
  try { d = JSON.parse(line); } catch { return; }
  const at = d.timestamp ? Date.parse(d.timestamp) : null;
  const msg = d.message;
  if (!msg || (d.type !== "user" && d.type !== "assistant") || d.isSidechain) return;
  if (at) T.lastEventAt = at;

  if (d.type === "assistant") {
    if (msg.id && msg.usage) {
      T.usageById.set(msg.id, msg.usage);
      const u = msg.usage;
      T.lastContext = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
    for (const b of msg.content ?? []) {
      if (b.type === "text" && b.text.trim()) {
        T.trace.push({ at, text: b.text.trim() });
        T.status = msg.stop_reason === "end_turn" ? "IDLE" : "THINKING";
      } else if (b.type === "tool_use") {
        const code = b.input?.code ?? (b.name.endsWith("portal_screenshot") ? "portal.screenshot()" : JSON.stringify(b.input));
        T.toolNames.set(b.id, { name: b.name, code, at });
        if (b.name.startsWith("mcp__portal__")) {
          T.toolCalls++;
          if (at) T.callTimes.push(at);
        }
        T.status = "ACTING";
      }
    }
    if (msg.stop_reason === "end_turn") T.status = "IDLE";
  } else if (d.type === "user") {
    const content = msg.content;
    if (typeof content === "string" || content?.some?.((b) => b.type === "text" && !b.text.startsWith("[Request interrupted"))) {
      if (!T.startedAt && at) T.startedAt = at;
      T.status = "THINKING";
    }
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type !== "tool_result") continue;
      const call = T.toolNames.get(b.tool_use_id);
      T.status = "THINKING";
      if (!call?.name.startsWith("mcp__portal__")) continue;
      const blocks = Array.isArray(b.content) ? b.content : [];
      const img = blocks.find((x) => x.type === "image" && x.source?.data);
      if (img) {
        T.agentView = `data:${img.source.media_type};base64,${img.source.data}`;
        T.agentViewAt = at;
      }
      if (call.name.endsWith("portal_exec")) {
        const result = summarizeResult(blocks.length ? blocks : b.content);
        const ticks = result.match(/"ticks": (\d+)/);
        if (ticks) T.execTicks.push({ at, ticks: Number(ticks[1]) });
        T.actions.push({ at: call.at, code: call.code, result: b.is_error ? `error: ${result}` : result });
      }
    }
  }
  T.trace = T.trace.slice(-12);
  T.actions = T.actions.slice(-8);
}

function pollTranscript() {
  const latest = latestTranscript();
  if (latest && latest !== T.file) T = freshState(latest);
  if (!T.file) return;
  let size;
  try { size = fs.statSync(T.file).size; } catch { return; }
  if (size < T.offset) T = freshState(T.file);
  if (size === T.offset) return;
  const fd = fs.openSync(T.file, "r");
  const buf = Buffer.alloc(size - T.offset);
  fs.readSync(fd, buf, 0, buf.length, T.offset);
  fs.closeSync(fd);
  T.offset = size;
  const lines = (T.partial + buf.toString("utf8")).split("\n");
  T.partial = lines.pop();
  for (const line of lines) if (line.trim()) ingest(line);
}

// --- Splits from speedrun demo files ----------------------------------------

function mapOf(stem) {
  const match = MAPS.map(([m]) => m).filter((m) => stem.startsWith(m)).sort((a, b) => b.length - a.length)[0];
  return match ?? null;
}

function readSplits() {
  let runDir = null;
  try {
    const runs = fs.readdirSync(DEMO_ROOT).filter((n) => fs.statSync(path.join(DEMO_ROOT, n)).isDirectory()).sort();
    runDir = runs.length ? path.join(DEMO_ROOT, runs[runs.length - 1]) : null;
  } catch {}
  const firstSeen = new Map();
  let gameSeconds = 0;
  if (runDir) {
    for (const f of fs.readdirSync(runDir).filter((n) => n.endsWith(".dem"))) {
      const file = path.join(runDir, f);
      const t = fs.statSync(file).birthtimeMs;
      gameSeconds += demoSeconds(file, t);
      const map = mapOf(f.slice(0, -4));
      if (!map) continue;
      if (!firstSeen.has(map) || t < firstSeen.get(map)) firstSeen.set(map, t);
    }
  }
  const reached = MAPS.filter(([m]) => firstSeen.has(m));
  const currentMap = reached.length ? reached[reached.length - 1][0] : null;
  const splits = MAPS.map(([map, label], i) => {
    // A chamber's split is the moment the next chamber's demo started.
    const next = MAPS[i + 1] && firstSeen.get(MAPS[i + 1][0]);
    return { map, label, done: Boolean(next), splitAt: next ?? null, current: map === currentMap };
  });
  return { splits, gameSeconds };
}

// In-game time of one demo. The header's playback_time (float at byte 1056)
// is written when the demo closes; while a map is still recording it holds a
// placeholder, so count the ticks the agent has played since the demo began.
function demoSeconds(file, bornAt) {
  try {
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(1064);
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const seconds = head.readFloatLE(1056);
    if (head.toString("latin1", 0, 7) === "HL2DEMO" && seconds > 0) return seconds;
  } catch {}
  return T.execTicks.filter((e) => e.at >= bornAt).reduce((sum, e) => sum + e.ticks, 0) / TICKRATE;
}

// --- Journal, scene and speech ----------------------------------------------

let journalOffset = 0;
const journalEntries = [];

// The controller's own record of the run: objective, and independent of which
// client is playing.
function pollJournal() {
  try {
    const size = fs.statSync(JOURNAL).size;
    if (size < journalOffset) journalOffset = 0;
    if (size === journalOffset) return;
    const fd = fs.openSync(JOURNAL, "r");
    const buf = Buffer.alloc(size - journalOffset);
    fs.readSync(fd, buf, 0, buf.length, journalOffset);
    fs.closeSync(fd);
    journalOffset = size;
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        journalEntries.push(JSON.parse(line));
      } catch {}
    }
    journalEntries.splice(0, Math.max(0, journalEntries.length - 40));
  } catch {}
}

function sidecar(line, expect) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: CAPTURE_PORT });
    const chunks = [];
    socket.setTimeout(4000, () => socket.destroy(new Error("timeout")));
    socket.on("connect", () => socket.write(line + "\n"));
    socket.on("data", (c) => chunks.push(c));
    socket.on("error", reject);
    socket.on("end", () => {
      const data = Buffer.concat(chunks);
      const nl = data.indexOf(0x0a);
      if (nl < 0) return reject(new Error("empty"));
      const header = data.subarray(0, nl).toString().split(" ");
      if (header[0] !== expect) return reject(new Error(header.join(" ")));
      resolve({ header, body: data.subarray(nl + 1) });
    });
  });
}

let sceneOffset = 0;
let scene = null;
let heardOffset = 0;
const heardLines = [];

async function pollPerception() {
  try {
    const { header, body } = await sidecar(`SCENE ${sceneOffset}`, "SCENE");
    sceneOffset = Number(header[1]);
    const payload = JSON.parse(body.toString("utf8") || "{}");
    if (payload.scene && Object.keys(payload.scene).length) scene = payload.scene;
  } catch {}
  try {
    const { header, body } = await sidecar(`HEARD ${heardOffset}`, "HEARD");
    heardOffset = Number(header[1]);
    for (const row of JSON.parse(body.toString("utf8") || "[]")) heardLines.push(row.text ?? String(row));
    heardLines.splice(0, Math.max(0, heardLines.length - 12));
  } catch {}
}

// --- State ------------------------------------------------------------------

function snapshot() {
  let input = 0, output = 0, cost = 0;
  for (const u of T.usageById.values()) {
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? ((u.cache_creation_input_tokens ?? 0) - w1h);
    const read = u.cache_read_input_tokens ?? 0;
    input += (u.input_tokens ?? 0) + read + w1h + w5m;
    output += u.output_tokens ?? 0;
    cost += ((u.input_tokens ?? 0) * PRICE.input + (u.output_tokens ?? 0) * PRICE.output + read * PRICE.cacheRead +
      w5m * PRICE.cacheWrite5m + w1h * PRICE.cacheWrite1h) / 1e6;
  }
  const now = Date.now();
  const bins = Array(45).fill(0); // tool calls per minute, last 45 min
  for (const t of T.callTimes) {
    const ago = Math.floor((now - t) / 60000);
    if (ago >= 0 && ago < 45) bins[44 - ago]++;
  }
  pollJournal();
  // Portal keeps in-game time in its demo files; Portal 2 has no demos here,
  // so the ticks the controller actually played are summed instead.
  const { splits, gameSeconds: demoSeconds } = readSplits();
  const journalTicks = journalEntries.reduce((sum, e) => sum + (Number(e.ticks) || 0), 0);
  const gameSeconds = GAME === "portal" ? demoSeconds : journalTicks / 60;
  return {
    now,
    startedAt: T.startedAt,
    context: T.lastContext, contextWindow: CONTEXT_WINDOW,
    input, output, cost,
    toolCalls: T.toolCalls,
    gameSeconds,
    status: T.status,
    lastEventAt: T.lastEventAt,
    trace: T.trace.slice(-6).reverse(),
    actions: T.actions.slice(-6).reverse(),
    agentViewAt: T.agentViewAt,
    activity: bins,
    game: GAME,
    scene,
    heard: heardLines.slice(-6).reverse(),
    journal: journalEntries.slice(-12).reverse().map((e) => ({
      t: e.t, type: e.type, code: e.code, ticks: e.ticks, moved: e.moved,
      heard: e.heard, scene: e.scene, message: e.message, returned: e.returned,
    })),
    splits: splits.map((s) => ({ ...s, splitAt: s.splitAt && T.startedAt ? s.splitAt - T.startedAt : null })),
  };
}

// --- Live game frame via the capture daemon ---------------------------------

function captureFrame() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: CAPTURE_PORT });
    const chunks = [];
    socket.setTimeout(5000, () => socket.destroy(new Error("capture timeout")));
    socket.on("connect", () => socket.write(`${GAME_W} ${GAME_H} ${GAME_W} ${GAME_H}\n`));
    socket.on("data", (c) => chunks.push(c));
    socket.on("error", reject);
    socket.on("end", () => {
      const data = Buffer.concat(chunks);
      const nl = data.indexOf(0x0a);
      const header = data.subarray(0, nl).toString().split(" ");
      if (header[0] !== "OK") return reject(new Error(header.slice(1).join(" ")));
      resolve(data.subarray(nl + 1));
    });
  });
}

// --- HTTP -------------------------------------------------------------------

const html = () => fs.readFileSync(path.join(here, "index.html"));

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html());
    } else if (url.pathname === "/state.json") {
      pollTranscript();
      await pollPerception();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(snapshot()));
    } else if (url.pathname === "/agent.jpg") {
      if (!T.agentView) return res.writeHead(404).end();
      const [, b64] = T.agentView.split(",");
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" }).end(Buffer.from(b64, "base64"));
    } else if (url.pathname === "/game.jpg") {
      const jpg = await captureFrame();
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" }).end(jpg);
    } else {
      res.writeHead(404).end();
    }
  } catch (e) {
    res.writeHead(503, { "content-type": "text/plain" }).end(String(e.message ?? e));
  }
}).listen(PORT, "127.0.0.1", () => {
  pollTranscript();
  console.error(`[overlay] http://127.0.0.1:${PORT}  transcript=${T.file ?? "(none yet)"}  demos=${DEMO_ROOT}`);
});
