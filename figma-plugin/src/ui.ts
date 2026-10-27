// Plugin window: the WebSocket to Doppl (ws://localhost:<port>), pairing, status, and the Cancel button.
// Messages larger than CHUNK are split in both directions; Figma's docs don't state a postMessage or
// WebSocket size limit for plugins, so large exports and images travel in pieces.

const CHUNK = 512 * 1024;
const port = Number(document.querySelector('meta[name="doppl-port"]')?.getAttribute("content")) || 47810;
const ADDRESS = `ws://localhost:${port}`;

let ws: WebSocket | null = null;
let code = "";
let info: { fileName?: string } | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let rejected = false;
let running = 0;
const incoming = new Map<string, string[]>();

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const setStatus = (text: string) => ($("status").textContent = text);
const setActivity = (text: string) => ($("activity").textContent = text);
const toCode = (msg: Record<string, unknown>) => parent.postMessage({ pluginMessage: msg }, "*");
const connectedText = () => `Connected to Doppl${info?.fileName ? ` · ${info.fileName}` : ""}`;

function send(msg: Record<string, unknown>) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const text = JSON.stringify(msg);
  if (text.length <= CHUNK) {
    ws.send(text);
    return;
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const n = Math.ceil(text.length / CHUNK);
  for (let i = 0; i < n; i++) ws.send(JSON.stringify({ type: "chunk", id, i, n, data: text.slice(i * CHUNK, (i + 1) * CHUNK) }));
}

/** Returns the message once all its chunks arrived (or right away when it wasn't split). */
function receive(text: string): Record<string, any> | null {
  const msg = JSON.parse(text);
  if (msg.type !== "chunk") return msg;
  const parts = incoming.get(msg.id) ?? new Array(msg.n);
  parts[msg.i] = msg.data;
  incoming.set(msg.id, parts);
  if (parts.filter((p) => p !== undefined).length < msg.n) return null;
  incoming.delete(msg.id);
  return JSON.parse(parts.join(""));
}

function showPair(message?: string) {
  $("pair").hidden = false;
  if (message) setStatus(message);
  ($("code") as HTMLInputElement).focus();
}

function setRunning(delta: number) {
  running = Math.max(0, running + delta);
  $("cancel").hidden = running === 0;
  if (running === 0) setActivity("");
}

function connect() {
  clearTimeout(retryTimer);
  rejected = false;
  ws = new WebSocket(ADDRESS);
  ws.onopen = () => send({ type: "hello", code, fileName: info?.fileName, fileKey: (info as any)?.fileKey, pageName: (info as any)?.pageName, pluginVersion: (info as any)?.pluginVersion });
  ws.onmessage = (event) => {
    const msg = receive(String(event.data));
    if (!msg) return;
    if (msg.type === "welcome") {
      $("pair").hidden = true;
      setStatus(connectedText());
    } else if (msg.type === "rejected") {
      rejected = true;
      showPair(msg.reason === "code" ? "The pairing code doesn't match Doppl's." : "Doppl refused the connection.");
    } else if (msg.type === "request") {
      setRunning(1);
      toCode(msg);
    } else if (msg.type === "cancel") {
      toCode({ type: "cancel", id: msg.id });
    }
  };
  ws.onclose = () => {
    running = 0;
    setRunning(0);
    if (rejected) return;
    setStatus("Waiting for the Doppl app on this Mac…");
    retryTimer = setTimeout(connect, 2000);
  };
}

$("save").onclick = () => {
  code = ($("code") as HTMLInputElement).value.trim().toUpperCase();
  if (!code) return;
  toCode({ type: "saveCode", code });
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  connect();
};

$("cancel").onclick = () => {
  toCode({ type: "cancel" });
  setActivity("Cancelling…");
};

window.onmessage = (event: MessageEvent) => {
  const msg = event.data?.pluginMessage;
  if (!msg) return;
  if (msg.type === "init") {
    info = msg.info;
    code = msg.code || "";
    if (code) connect();
    else showPair("Pair this plugin with Doppl once.");
  } else if (msg.type === "info") {
    info = msg.info;
    send({ type: "info", info });
    if (ws?.readyState === WebSocket.OPEN && !rejected) setStatus(connectedText());
  } else if (msg.type === "response") {
    send(msg);
    setRunning(-1);
  } else if (msg.type === "progress") {
    send(msg);
  } else if (msg.type === "activity") {
    if (running > 0) setActivity(msg.text);
  }
};

toCode({ type: "ready" });
