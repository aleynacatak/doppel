import http from "node:http";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { type WebSocket, WebSocketServer } from "ws";

// Local connection between Doppel and the Doppel plugin running inside Figma (figma-plugin/).
// The plugin's window opens ws://localhost:17433. Doppel listens on loopback only, refuses web
// pages (they send a real Origin; Figma plugin windows don't), and requires the pairing code.

export const PLUGIN_PORT = 17433;

export interface PluginInfo {
  version: number;
  fileName: string;
  fileKey?: string;
  pageId: string;
  pageName: string;
  pages: { id: string; name: string }[];
}

export class PluginNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginNotConnectedError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const sameCode = (a: string, b: string) => {
  const ha = createHash("sha256").update(a.trim().toUpperCase()).digest();
  const hb = createHash("sha256").update(b.trim().toUpperCase()).digest();
  return timingSafeEqual(ha, hb);
};

const allowedOrigin = (origin: string | undefined) =>
  !origin || origin === "null" || /^https:\/\/([a-z0-9-]+\.)*figma\.com$/i.test(origin);

export class FigmaPluginBridge {
  private socket: WebSocket | null = null;
  private info: PluginInfo | null = null;
  private pending = new Map<string, Pending>();
  private listeners = new Set<() => void>();
  private servers: http.Server[] = [];

  constructor(private readonly pairingCode: () => string) {}

  start() {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
    for (const host of ["127.0.0.1", "::1"]) {
      const server = http.createServer((_req, res) => {
        res.writeHead(426);
        res.end();
      });
      server.on("upgrade", (req, socket, head) => {
        if (!allowedOrigin(req.headers.origin)) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
      });
      server.on("error", (err) => console.error(`[figma plugin] can't listen on ${host}:${PLUGIN_PORT}: ${err.message}`));
      server.listen(PLUGIN_PORT, host);
      this.servers.push(server);
    }
  }

  stop() {
    for (const s of this.servers) s.close();
    this.socket?.close();
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  status() {
    return { connected: !!this.socket && !!this.info, info: this.info };
  }

  private accept(ws: WebSocket) {
    let paired = false;
    const helloTimer = setTimeout(() => !paired && ws.close(), 10_000);
    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!paired) {
        if (msg.type !== "hello") return;
        if (typeof msg.code !== "string" || !sameCode(msg.code, this.pairingCode())) {
          ws.send(JSON.stringify({ type: "rejected" }));
          ws.close();
          return;
        }
        paired = true;
        clearTimeout(helloTimer);
        if (this.socket && this.socket !== ws) this.socket.close();
        this.socket = ws;
        this.info = msg.info ?? null;
        ws.send(JSON.stringify({ type: "welcome" }));
        this.notify();
        return;
      }
      if (msg.type === "info") {
        this.info = msg.info ?? this.info;
        this.notify();
      } else if (msg.type === "response" && typeof msg.id === "string") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(String(msg.error ?? "The routine failed in Figma.")));
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (this.socket !== ws) return;
      this.socket = null;
      this.info = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new PluginNotConnectedError("The Doppel plugin in Figma was closed before the routine finished."));
        this.pending.delete(id);
      }
      this.notify();
    });
  }

  /** Sends a request to the plugin and waits for its answer. */
  request<T>(payload: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const socket = this.socket;
    if (!socket) throw new PluginNotConnectedError("The Doppel plugin isn't open in Figma.");
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Figma didn't finish within ${Math.round(timeoutMs / 1000)} seconds. You can raise the limit in Settings.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ type: "request", id, payload }));
    });
  }
}
