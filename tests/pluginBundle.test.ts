import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { FakeFigma } from "./helpers/fakeFigma";

// Loads the BUILT plugin (figma-plugin/dist/code.js) in a sandbox with a fake Figma API, then talks to it the way
// the plugin window does: ready → init, beginStage → runItem → endStage. Catches bundling problems (target,
// zod at load time) that the source-level interpreter tests can't see.

const root = path.join(__dirname, "..");
let code = "";

beforeAll(() => {
  execFileSync(process.execPath, [path.join(root, "scripts", "build-figma-plugin.mjs")], { stdio: "ignore" });
  code = fs.readFileSync(path.join(root, "figma-plugin", "dist", "code.js"), "utf8");
});

function load() {
  const figma = new FakeFigma();
  const card = figma.node("FRAME", "Card", figma.currentPage, { width: 200, height: 100 });
  figma.node("TEXT", "Title", card, { width: 180, height: 20, characters: "Title" });
  const sent: Record<string, any>[] = [];
  const storage = new Map<string, unknown>();
  const api = Object.assign(figma, {
    showUI: () => undefined,
    ui: { postMessage: (m: Record<string, any>) => sent.push(m), onmessage: null as null | ((m: unknown) => Promise<void>) },
    clientStorage: { getAsync: async (k: string) => storage.get(k), setAsync: async (k: string, v: unknown) => void storage.set(k, v) },
    on: () => undefined,
    commitUndo: () => undefined,
    setCurrentPageAsync: async (p: typeof figma.currentPage) => void (figma.currentPage = p),
    viewport: { scrollAndZoomIntoView: () => undefined },
    listAvailableFontsAsync: async () => [{ fontName: { family: "Inter", style: "Regular" } }],
    fileKey: "KEY123",
  });
  (figma.root as any).name = "Test file";
  vm.runInNewContext(code, { figma: api, __html__: "<html></html>", console });
  const request = async (payload: Record<string, unknown>) => {
    const id = String(sent.length + Math.random());
    await api.ui.onmessage!({ type: "request", id, payload });
    const res = sent.find((m) => m.type === "response" && m.id === id);
    if (!res?.ok) throw new Error(res?.error ?? "no response");
    return res.result;
  };
  return { figma, api, sent, request, storage };
}

describe("built Figma plugin", () => {
  it("loads, introduces itself and runs a stage", async () => {
    const { api, sent, request, figma } = load();
    await api.ui.onmessage!({ type: "ready" });
    expect(sent.find((m) => m.type === "init")).toMatchObject({ info: { fileName: "Test file", fileKey: "KEY123", pluginVersion: "2.1.0" }, code: "" });

    const begin = await request({ type: "beginStage", mode: "trial", routineName: "Labels" });
    expect(figma.currentPage.name).toBe("Doppl trial · Labels");
    const res = await request({
      type: "runItem",
      stageSessionId: begin.stageSessionId,
      label: "Row 1",
      actions: [
        { action: "duplicateNode", id: "copy", node: "Card", name: "Card 1" },
        { action: "setText", node: "$copy.#Title", text: "Honey" },
        { action: "exportNode", node: "$copy", format: "PNG", output: "files" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.exports).toHaveLength(1);
    expect(res.shown[0]).toMatchObject({ name: "Card 1" });
    await request({ type: "endStage", stageSessionId: begin.stageSessionId });
    await request({ type: "finishPage", pageId: begin.pageId });
    expect(figma.currentPage.name).toBe("Page 1");
    expect(figma.root.children.map((p) => p.name)).toEqual(["Page 1"]);
  });

  it("starts from the routine's page whatever page is open, and goes back to the designer's page", async () => {
    const { request, figma } = load();
    const labels = figma.root.children[0];
    labels.name = "jam-a-dox";
    const other = figma.createPage();
    other.name = "Page 10";
    figma.currentPage = other;
    const begin = await request({ type: "beginStage", mode: "copy", routineName: "Labels", source: { id: labels.id, name: "jam-a-dox" } });
    expect(begin.source).toEqual({ id: labels.id, name: "jam-a-dox" });
    expect(figma.currentPage.name).toBe("jam-a-dox (Doppl copy)");
    expect(figma.currentPage.findOne((n) => n.name === "Card")).toBeTruthy();
    // Results are kept: the copy stays and Figma shows the page the designer had open.
    await request({ type: "finishPage", pageId: begin.pageId, remove: false });
    expect(figma.currentPage).toBe(other);
    expect(figma.root.children.map((p) => p.name)).toEqual(["jam-a-dox", "jam-a-dox (Doppl copy)", "Page 10"]);

    // An older routine (no page saved) run while a Doppl copy is open starts from the designer's page, not the copy;
    // a copy that kept nothing is removed.
    figma.currentPage = figma.root.children[1];
    const again = await request({ type: "beginStage", mode: "copy", routineName: "Labels" });
    expect(again.source.name).toBe("jam-a-dox");
    await request({ type: "finishPage", pageId: again.pageId, remove: true });
    expect(figma.root.children.map((p) => p.name)).toEqual(["jam-a-dox", "jam-a-dox (Doppl copy)", "Page 10"]);
    expect(figma.currentPage.name).toBe("jam-a-dox (Doppl copy)");
  });

  it("validates actions again inside the plugin", async () => {
    const { request } = load();
    const begin = await request({ type: "beginStage", mode: "original", routineName: "x" });
    await expect(request({ type: "runItem", stageSessionId: begin.stageSessionId, actions: [{ action: "setText", node: "Title" }] })).rejects.toThrow(
      "The actions don't match the catalog",
    );
  });
});
