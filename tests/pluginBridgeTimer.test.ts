import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { FigmaPluginBridge, toFrames } from "../electron/adapters/figma/pluginBridge";
import { failureCause } from "../electron/core/flows/failures";

// A long job in Figma sends a progress message before each step. The time limit covers one step, so a job of many
// quick steps can take longer than the limit, and a step that hangs still ends. These go through a real local socket,
// with a stand-in for the plugin.

const CODE = "TEST-CODE";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

let stopAll: (() => void) | undefined;
afterEach(() => {
  stopAll?.();
  stopAll = undefined;
});

/** A running bridge and a stand-in plugin connected to it. `received` collects what the bridge sends the plugin. */
async function connect() {
  const port = await freePort();
  const bridge = new FigmaPluginBridge(
    () => CODE,
    () => port,
  );
  bridge.start();
  const plugin = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: Record<string, any>[] = [];
  plugin.on("message", (raw) => received.push(JSON.parse(String(raw))));
  stopAll = () => {
    plugin.close();
    bridge.stop();
  };
  await new Promise((resolve, reject) => {
    plugin.once("open", resolve);
    plugin.once("error", reject);
  });
  plugin.send(JSON.stringify({ type: "hello", code: CODE, fileName: "Test", fileKey: "key", pluginVersion: "test" }));
  for (let i = 0; i < 100 && !bridge.list().length; i++) await wait(10);
  const sessionId = bridge.list()[0].id;

  /** Waits until the request reached the plugin, and gives its id. */
  const requestId = async () => {
    for (let i = 0; i < 100; i++) {
      const id = received.find((m) => m.type === "request")?.id;
      if (id) return String(id);
      await wait(10);
    }
    throw new Error("The request never reached the plugin.");
  };
  return { bridge, plugin, received, sessionId, requestId };
}

describe("the Figma time limit", () => {
  it("lets a job of many quick steps run longer than the limit", async () => {
    const { bridge, plugin, sessionId, requestId } = await connect();
    const seen: string[] = [];
    const { done } = bridge.request<string>(sessionId, { type: "runItem" }, { timeoutMs: 300, onProgress: (t) => seen.push(t) });
    const id = await requestId();
    const started = Date.now();
    for (let step = 1; step <= 6; step++) {
      plugin.send(JSON.stringify({ type: "progress", id, text: `exportNode (${step} of 6)` }));
      await wait(120);
    }
    plugin.send(JSON.stringify({ type: "response", id, ok: true, result: "finished" }));
    await expect(done).resolves.toBe("finished");
    expect(Date.now() - started).toBeGreaterThan(300);
    expect(seen).toHaveLength(6);
  });

  it("still ends a step that hangs, says which one and tells the plugin to stop", async () => {
    const { bridge, plugin, received, sessionId, requestId } = await connect();
    const { done } = bridge.request(sessionId, { type: "runItem" }, { timeoutMs: 1000 });
    const failed = expect(done).rejects.toThrow("Figma didn't finish within 1 seconds of starting exportNode (2 of 6). You can raise the limit in Settings.");
    const id = await requestId();
    plugin.send(JSON.stringify({ type: "progress", id, text: "exportNode (1 of 6)" }));
    plugin.send(JSON.stringify({ type: "progress", id, text: "exportNode (2 of 6)" }));
    await failed;
    await wait(50);
    expect(received.some((m) => m.type === "cancel" && m.id === id)).toBe(true);
  });

  it("keeps the plain wording when no step was reported, such as while a page is copied", async () => {
    const { bridge, sessionId } = await connect();
    const { done } = bridge.request(sessionId, { type: "beginStage" }, { timeoutMs: 1000 });
    await expect(done).rejects.toThrow("Figma didn't finish within 1 seconds. You can raise the limit in Settings.");
  });

  it("counts the parts of a long answer as Figma still working", async () => {
    const { bridge, plugin, sessionId, requestId } = await connect();
    const { done } = bridge.request<{ data: string }>(sessionId, { type: "runItem" }, { timeoutMs: 300 });
    const id = await requestId();
    const frames = toFrames({ type: "response", id, ok: true, result: { data: "x".repeat(2_500_000) } });
    expect(frames.length).toBeGreaterThan(4);
    for (const frame of frames) {
      plugin.send(frame);
      await wait(120);
    }
    expect((await done).data).toHaveLength(2_500_000);
  });

  it("treats the new wording as a problem with the app, as before", () => {
    expect(failureCause("Figma didn't finish within 120 seconds of starting exportNode (3 of 14). You can raise the limit in Settings.", false)).toBe("app");
  });
});
