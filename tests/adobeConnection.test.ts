import { describe, expect, it } from "vitest";
import { type AdobeBridge, BridgeError } from "../electron/adapters/adobe/bridge";
import { AdobeConnection } from "../electron/adapters/adobe/connection";

// A bridge whose probe answers only when the test says so (like macOS's permission prompt).
function fakeBridge() {
  let answer: ((v: unknown) => void) | null = null;
  let fail: ((e: unknown) => void) | null = null;
  const bridge = {
    isInstalled: async () => true,
    isRunning: async () => true,
    isBusy: () => false,
    runJsx: () =>
      new Promise((resolve, reject) => {
        answer = resolve;
        fail = reject;
      }),
  } as unknown as AdobeBridge;
  return { bridge, allow: () => answer?.({ version: "27.1.0" }), deny: () => fail?.(new BridgeError("permission-denied", "not allowed")) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Adobe connection status", () => {
  it("answers quickly while macOS asks for permission, then reports the answer", async () => {
    const { bridge, allow } = fakeBridge();
    let changes = 0;
    const conn = new AdobeConnection(bridge, "function () {}", () => 60, { onChange: () => changes++, promptAfterMs: 30, quickAnswerMs: 10 });
    const started = Date.now();
    expect(await conn.getStatus()).toBe("not-running");
    expect(Date.now() - started).toBeLessThan(500);
    await sleep(40);
    expect(await conn.getStatus()).toBe("awaiting-permission");
    allow();
    await sleep(5);
    expect(changes).toBe(1);
    expect(await conn.getStatus()).toBe("connected");
    expect(conn.version).toBe("27.1.0");
  });

  it("reports a denied permission", async () => {
    const { bridge, deny } = fakeBridge();
    const conn = new AdobeConnection(bridge, "function () {}", () => 60, { promptAfterMs: 30, quickAnswerMs: 10 });
    await conn.getStatus();
    deny();
    await sleep(5);
    expect(await conn.getStatus()).toBe("permission-denied");
  });

  it("connects at once when the app answers quickly", async () => {
    const bridge = { isInstalled: async () => true, isRunning: async () => true, isBusy: () => false, runJsx: async () => ({ version: "21.6" }) } as unknown as AdobeBridge;
    const conn = new AdobeConnection(bridge, "function () {}", () => 60);
    expect(await conn.getStatus()).toBe("connected");
  });
});
