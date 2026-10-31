import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { figmaDocumentId, fromFrame, toFrames } from "../electron/adapters/figma/pluginBridge";
import { imageSize, ItemDataError, prepareActions } from "../electron/adapters/figma/prepareActions";

describe("plugin connection", () => {
  it("splits long messages into chunks and puts them back together in any order", () => {
    const msg = { type: "response", id: "1", ok: true, result: { data: "x".repeat(1_300_000) } };
    const frames = toFrames(msg);
    expect(frames.length).toBe(3);
    const chunks = new Map<string, string[]>();
    expect(fromFrame(frames[2], chunks)).toBeNull();
    expect(fromFrame(frames[0], chunks)).toBeNull();
    expect(fromFrame(frames[1], chunks)).toEqual(msg);
    expect(chunks.size).toBe(0);
    expect(toFrames({ type: "info" })).toHaveLength(1);
  });

  it("identifies files by key, or by name when Figma doesn't share the key", () => {
    expect(figmaDocumentId("abc", "Campaign")).toBe("figma:abc");
    expect(figmaDocumentId(undefined, "Campaign")).toBe("figma-name:Campaign");
  });
});

function png(width: number, height: number) {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

describe("preparing actions for the plugin", () => {
  it("reads images by folder and name, and checks their size", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-prep-"));
    await fs.writeFile(path.join(dir, "Honey.PNG"), png(800, 600));
    await fs.writeFile(path.join(dir, "huge.png"), png(5000, 100));
    const res = await prepareActions([{ action: "setImageFill", node: "Photo", image: { folder: dir, name: "honey" } }], [dir]);
    expect((res.actions[0].image as { name: string }).name).toBe("Honey.PNG");
    expect(imageSize(png(800, 600))).toEqual({ width: 800, height: 600, type: "png" });
    await expect(prepareActions([{ action: "setImageFill", node: "Photo", image: { folder: dir, name: "huge" } }], [dir])).rejects.toThrow("5000×100 px");
    const missing = prepareActions([{ action: "setImageFill", node: "Photo", image: { folder: dir, name: "jam" } }], [dir]);
    await expect(missing).rejects.toBeInstanceOf(ItemDataError);
    await expect(missing).rejects.toMatchObject({ finding: { type: "file-missing" } });
  });

  it("draws valid barcodes and fails items with a wrong check digit", async () => {
    const ok = await prepareActions([{ action: "placeSvg", node: "Barcode", svg: { barcode: { type: "ean13", value: "400638133393" } } }], []);
    expect(String(ok.actions[0].svg)).toMatch(/^<svg/);
    expect(ok.barcodes).toEqual(["ean13:4006381333931"]);
    await expect(prepareActions([{ action: "placeSvg", node: "Barcode", svg: { barcode: { type: "ean13", value: "4006381333932" } } }], [])).rejects.toMatchObject({
      finding: { type: "barcode-invalid" },
    });
  });

  it("keeps exports inside the routine's working folder, never the designer's folders", async () => {
    await expect(prepareActions([{ action: "exportNode", node: "A", format: "PNG", folder: "/tmp/photos" }], ["/tmp/work"])).rejects.toThrow("only go into the routine's working folder");
  });
});
