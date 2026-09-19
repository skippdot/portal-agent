// Perception shared by both games: the scene analysis produced by
// tools/vision-daemon.py and past frames ("rewind") from tools/game-tap's
// recording. Both are served by the macOS capture sidecar, so the sandboxed
// broker needs no extra permissions - it already talks to that one socket.

import net from "node:net";

const REQUEST_TIMEOUT_MS = 15000;

function request(host, port, line, { expect }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks = [];
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy(new Error(`${expect} request timed out`)));
    socket.on("connect", () => socket.write(line + "\n"));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", (error) => reject(new Error(`${expect} request failed: ${error.message}`)));
    socket.on("end", () => {
      const data = Buffer.concat(chunks);
      const newline = data.indexOf(0x0a);
      if (newline < 0) return reject(new Error(`${expect}: empty response`));
      const header = data.subarray(0, newline).toString("utf8").split(" ");
      if (header[0] !== expect) return reject(new Error(`${expect} failed: ${header.join(" ")}`));
      resolve({ header, body: data.subarray(newline + 1) });
    });
  });
}

// Tracks the read cursor into the scene event log so each call returns only
// what happened since the previous one.
export class ScenePerception {
  constructor({ host = "127.0.0.1", port } = {}) {
    this.host = host;
    this.port = port ?? null;
    this.offset = null;
  }

  get available() {
    return Boolean(this.port);
  }

  // { scene, events } - the current scene plus what changed since last call.
  async poll({ reset = false } = {}) {
    if (!this.port) return { scene: null, events: [] };
    const { header, body } = await request(this.host, this.port, `SCENE ${this.offset ?? 0}`, { expect: "SCENE" });
    const payload = JSON.parse(body.toString("utf8") || "{}");
    const first = this.offset === null;
    this.offset = Number(header[1]);
    return {
      scene: payload.scene && Object.keys(payload.scene).length ? payload.scene : null,
      events: first || reset ? [] : payload.events ?? [],
    };
  }

  // A JPEG of what the window showed `secondsAgo` seconds ago.
  async frameAt(secondsAgo, { width = 576, height = 360 } = {}) {
    if (!this.port) throw new Error("Rewind needs the capture sidecar (PORTAL_CAPTURE_PORT).");
    const seconds = Number(secondsAgo);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error(`Expected a non-negative number of seconds, got ${secondsAgo}.`);
    }
    const at = Date.now() - Math.round(seconds * 1000);
    const { header, body } = await request(this.host, this.port, `FRAME ${at} ${width} ${height}`, { expect: "OK" });
    return { bytes: body, width: Number(header[2]), height: Number(header[3]), at };
  }
}
