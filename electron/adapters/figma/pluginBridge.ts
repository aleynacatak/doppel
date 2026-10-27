import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { connectionLog } from "../../core/services/connectionLog";
import type { FigmaSession } from "../../core/types";

// Local connection between Doppl and the Doppl plugin running inside Figma (figma-plugin/). Each Figma file with
// the plugin open is one session: the plugin window opens ws://localhost:<port> and says hello with the file's
// name (and key when Figma shares it) and the pairing code; Doppl answers with a session id. Doppl listens on
// loopback only, refuses web pages (they send a real Origin; Figma plugin windows send "null"), and requires the
// pairing code, because sandboxed web pages also have the origin "null".

export const DEFAULT_PLUGIN_PORT = 47810;
/** Messages longer than this travel in chunks (both directions). */
const CHUNK = 512 * 1024;

export class PluginNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginNotConnectedError";
  }
}

/** The designer pressed Cancel in the plugin window (or Doppl cancelled the request). */
export class PluginCancelledError extends Error {
  constructor() {
    super("Cancelled in Figma.");
    this.name = "PluginCancelledError";
  }
}

export interface RequestOptions {
  timeoutMs: number;
  onProgress?: (text: string) => void;
  /** Label for the connection log, e.g. "runItem". */
  label?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  onProgress?: (text: string) => void;
  started: number;
  label: string;
}

interface Session {
  id: string;
  ws: WebSocket;
  info: FigmaSession;
  pending: Map<string, Pending>;
  chunks: Map<string, string[]>;
}

const sameCode = (a: string, b: string) => {
  const ha = createHash("sha256").update(a.trim().toUpperCase()).digest();
  const hb = createHash("sha256").update(b.trim().toUpperCase()).digest();
  return timingSafeEqual(ha, hb);
};

const allowedOrigin = (origin: string | undefined) => !origin || origin === "null" || /^https:\/\/([a-z0-9-]+\.)*figma\.com$/i.test(origin);

/** Stable document id for a Figma file: its key when the plugin shares it, otherwise its name. */
export const figmaDocumentId = (fileKey: string | undefined, fileName: string) => (fileKey ? `figma:${fileKey}` : `figma-name:${fileName}`);

/** Splits a message into chunk frames when it is long. */
export function toFrames(msg: Record<string, unknown>): string[] {
  const text = JSON.stringify(msg);
  if (text.length <= CHUNK) return [text];
  const id = randomUUID();
  const n = Math.ceil(text.length / CHUNK);
  return Array.from({ length: n }, (_, i) => JSON.stringify({ type: "chunk", id, i, n, data: text.slice(i * CHUNK, (i + 1) * CHUNK) }));
}

/** Reassembles chunked messages; returns the message once complete, null while parts are missing. */
export function fromFrame(raw: string, chunks: Map<string, string[]>): Record<string, any> | null {
  const msg = JSON.parse(raw);
  if (msg?.type !== "chunk") return msg;
  if (typeof msg.id !== "string" || !Number.isInteger(msg.i) || !Number.isInteger(msg.n) || msg.n > 10_000) return null;
  const parts = chunks.get(msg.id) ?? new Array<string>(msg.n);
  parts[msg.i] = String(msg.data ?? "");
  chunks.set(msg.id, parts);
  if (parts.filter((p) => p !== undefined).length < msg.n) return null;
  chunks.delete(msg.id);
  return JSON.parse(parts.join(""));
}

export class FigmaPluginBridge {
  private sessions = new Map<string, Session>();
  private listeners = new Set<() => void>();
  private servers: http.Server[] = [];
  private port = DEFAULT_PLUGIN_PORT;

  constructor(
    private readonly pairingCode: () => string,
    private readonly getPort: () => number,
  ) {}

  start() {
    this.port = this.getPort() || DEFAULT_PLUGIN_PORT;
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    for (const host of ["127.0.0.1", "::1"]) {
      const server = http.createServer((_req, res) => {
        res.writeHead(426);
        res.end();
      });
      server.on("upgrade", (req, socket, head) => {
        if (!allowedOrigin(req.headers.origin)) {
          connectionLog.add({ channel: "websocket", app: "figma", direction: "in", kind: "refused", ok: false, note: "web page origin" });
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
      });
      server.on("error", (err) => console.error(`[figma plugin] can't listen on ${host}:${this.port}: ${err.message}`));
      server.listen(this.port, host);
      this.servers.push(server);
    }
  }

  stop() {
    for (const s of this.servers) s.close();
    this.servers = [];
    for (const s of this.sessions.values()) s.ws.close();
  }

  /** Listens on a new port (Settings). Open plugin windows reconnect on their own once re-imported with the new port. */
  restart() {
    this.stop();
    this.start();
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  list(): FigmaSession[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }));
  }

  /** The session for a document id (several Figma files can be open; messages are routed by session). */
  sessionFor(documentId: string): FigmaSession | undefined {
    return this.list().find((s) => s.documentId === documentId);
  }

  private send(session: Session, msg: Record<string, unknown>) {
    for (const frame of toFrames(msg)) session.ws.send(frame);
  }

  private accept(ws: WebSocket) {
    let session: Session | null = null;
    const chunks = new Map<string, string[]>();
    const helloTimer = setTimeout(() => !session && ws.close(), 10_000);
    ws.on("message", (raw) => {
      let msg: Record<string, any> | null;
      try {
        msg = fromFrame(String(raw), session?.chunks ?? chunks);
      } catch {
        return;
      }
      if (!msg) return;
      if (!session) {
        if (msg.type !== "hello") return;
        if (typeof msg.code !== "string" || !sameCode(msg.code, this.pairingCode())) {
          connectionLog.add({ channel: "websocket", app: "figma", direction: "in", kind: "hello", ok: false, note: "wrong pairing code" });
          ws.send(JSON.stringify({ type: "rejected", reason: "code" }));
          ws.close();
          return;
        }
        clearTimeout(helloTimer);
        const fileName = String(msg.fileName ?? "Untitled");
        const fileKey = typeof msg.fileKey === "string" && msg.fileKey ? msg.fileKey : undefined;
        const documentId = figmaDocumentId(fileKey, fileName);
        // The same file reconnecting replaces its old session.
        for (const old of this.sessions.values()) if (old.info.documentId === documentId) old.ws.close();
        session = {
          id: randomUUID(),
          ws,
          chunks,
          pending: new Map(),
          info: {
            id: "",
            documentId,
            fileName,
            fileKey,
            pageName: typeof msg.pageName === "string" ? msg.pageName : undefined,
            pluginVersion: String(msg.pluginVersion ?? "?"),
            connectedAt: new Date().toISOString(),
          },
        };
        session.info.id = session.id;
        this.sessions.set(session.id, session);
        ws.send(JSON.stringify({ type: "welcome", sessionId: session.id }));
        connectionLog.add({ channel: "websocket", app: "figma", direction: "in", kind: "hello", ok: true, note: `plugin ${session.info.pluginVersion}` });
        this.notify();
        return;
      }
      this.handle(session, msg);
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (!session || this.sessions.get(session.id) !== session) return;
      this.sessions.delete(session.id);
      for (const [id, p] of session.pending) {
        clearTimeout(p.timer);
        p.reject(new PluginNotConnectedError("The Doppl plugin in Figma was closed before the step finished."));
        session.pending.delete(id);
      }
      connectionLog.add({ channel: "websocket", app: "figma", direction: "event", kind: "closed" });
      this.notify();
    });
  }

  private handle(session: Session, msg: Record<string, any>) {
    if (msg.type === "info" && msg.info) {
      session.info.pageName = typeof msg.info.pageName === "string" ? msg.info.pageName : session.info.pageName;
      if (typeof msg.info.fileName === "string") session.info.fileName = msg.info.fileName;
      this.notify();
    } else if (msg.type === "progress" && typeof msg.id === "string") {
      const p = session.pending.get(msg.id);
      if (p && typeof msg.text === "string") {
        session.info.activity = msg.text;
        p.onProgress?.(msg.text);
      }
    } else if (msg.type === "response" && typeof msg.id === "string") {
      const p = session.pending.get(msg.id);
      if (!p) return;
      session.pending.delete(msg.id);
      clearTimeout(p.timer);
      session.info.activity = undefined;
      connectionLog.add({
        channel: "websocket",
        app: "figma",
        direction: "in",
        kind: `response:${p.label}`,
        ok: !!msg.ok,
        ms: Date.now() - p.started,
        bytes: JSON.stringify(msg.result ?? msg.error ?? "").length,
      });
      if (msg.ok) p.resolve(msg.result);
      else if (msg.cancelled) p.reject(new PluginCancelledError());
      else p.reject(new Error(String(msg.error ?? "The step failed in Figma.")));
    }
  }

  /** Sends a request to the plugin in one file and waits for its answer. */
  request<T>(sessionId: string, payload: Record<string, unknown>, options: RequestOptions): { id: string; done: Promise<T> } {
    const session = this.sessions.get(sessionId);
    if (!session) throw new PluginNotConnectedError("The Doppl plugin isn't open in that Figma file.");
    const id = randomUUID();
    const label = options.label ?? String(payload.type ?? "request");
    const done = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        this.cancel(sessionId, id);
        reject(new Error(`Figma didn't finish within ${Math.round(options.timeoutMs / 1000)} seconds. You can raise the limit in Settings.`));
      }, options.timeoutMs);
      session.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, onProgress: options.onProgress, started: Date.now(), label });
    });
    const frames = toFrames({ type: "request", id, payload });
    for (const frame of frames) session.ws.send(frame);
    connectionLog.add({ channel: "websocket", app: "figma", direction: "out", kind: `request:${label}`, bytes: frames.reduce((n, f) => n + f.length, 0) });
    return { id, done };
  }

  cancel(sessionId: string, requestId: string) {
    const session = this.sessions.get(sessionId);
    if (session) this.send(session, { type: "cancel", id: requestId });
  }
}
