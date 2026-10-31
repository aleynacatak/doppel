import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInput } from "../electron/core/flows/values";
import { readImageInfo } from "../electron/core/helpers/imageInfo";
import { preflight } from "../electron/core/inputs/preflight";
import type { Flow, Routine } from "../electron/core/types";

// The check before a run reads image headers: a file that holds no picture fails on its own as the file's problem
// (the others run), and CMYK or very large images get a note.

function png(width: number, height: number) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** A JPEG whose frame header comes after a large ICC profile, as CMYK files have. */
function jpeg(width: number, height: number, components: number) {
  const icc = Buffer.alloc(4 + 60000);
  icc.writeUInt16BE(0xffe2, 0);
  icc.writeUInt16BE(60000 + 2, 2);
  const sof = Buffer.from([0xff, 0xc0, 0, 8 + 3 * components, 8, height >> 8, height & 255, width >> 8, width & 255, components, ...Array(3 * components).fill(1)]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), icc, sof, Buffer.from([0xff, 0xd9])]);
}

function psd(width: number, height: number, mode: number) {
  const b = Buffer.alloc(26);
  b.write("8BPS", 0, "latin1");
  b.writeUInt16BE(1, 4);
  b.writeUInt16BE(4, 12);
  b.writeUInt32BE(height, 14);
  b.writeUInt32BE(width, 18);
  b.writeUInt16BE(8, 22);
  b.writeUInt16BE(mode, 24);
  return b;
}

function tiff(width: number, height: number, photometric: number) {
  const b = Buffer.alloc(8 + 2 + 3 * 12 + 4);
  b.write("II*\0", 0, "latin1");
  b.writeUInt32LE(8, 4);
  b.writeUInt16LE(3, 8);
  [
    [256, 3, width],
    [257, 4, height],
    [262, 3, photometric],
  ].forEach(([tag, type, value], i) => {
    const at = 10 + i * 12;
    b.writeUInt16LE(tag, at);
    b.writeUInt16LE(type, at + 2);
    b.writeUInt32LE(1, at + 4);
    if (type === 3) b.writeUInt16LE(value, at + 8);
    else b.writeUInt32LE(value, at + 8);
  });
  return b;
}

async function folder(files: Record<string, Buffer | string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-images-"));
  for (const [name, data] of Object.entries(files)) await fs.writeFile(path.join(dir, name), data);
  return dir;
}

describe("image headers", () => {
  it("reads the format, the size and CMYK", async () => {
    const dir = await folder({ "a.png": png(640, 480), "b.jpg": jpeg(1200, 800, 4), "c.jpg": jpeg(300, 200, 3), "d.psd": psd(2000, 1000, 4), "e.tif": tiff(500, 400, 5), "f.png": "not a picture" });
    expect(await readImageInfo(path.join(dir, "a.png"))).toEqual({ format: "png", width: 640, height: 480 });
    expect(await readImageInfo(path.join(dir, "b.jpg"))).toEqual({ format: "jpeg", width: 1200, height: 800, cmyk: true });
    expect(await readImageInfo(path.join(dir, "c.jpg"))).toMatchObject({ format: "jpeg", cmyk: false });
    expect(await readImageInfo(path.join(dir, "d.psd"))).toEqual({ format: "psd", width: 2000, height: 1000, cmyk: true });
    expect(await readImageInfo(path.join(dir, "e.tif"))).toEqual({ format: "tiff", width: 500, height: 400, cmyk: true });
    expect(await readImageInfo(path.join(dir, "f.png"))).toBeNull();
    expect(await readImageInfo(path.join(dir, "missing.png"))).toBeUndefined();
  });

  it("fails an image that holds no picture on its own, as the file's problem", async () => {
    const dir = await folder({ "fig-and-walnut.png": "a text file", "pear.png": png(10, 10), "notes.txt": "hi" });
    const port = { key: "photos", label: "Photos", type: "fileList" as const, required: true, extensions: ["png"] };
    const { value, problems } = await resolveInput(port, dir);
    expect(value && value.kind === "list" && value.items.map((i) => i.label)).toEqual(["pear.png"]);
    expect(problems).toEqual([{ key: "file-fig-and-walnut.png", label: "fig-and-walnut.png", error: expect.stringContaining("fig-and-walnut.png isn't a readable image") }]);
    await expect(resolveInput({ ...port, type: "file" }, path.join(dir, "fig-and-walnut.png"))).rejects.toThrow("isn't a readable image");
  });

  it("says so before the run, with CMYK and very large images", async () => {
    const dir = await folder({ "broken.jpg": "", "cmyk.jpg": jpeg(1200, 800, 4), "huge.png": png(10000, 10000), "fine.png": png(100, 100) });
    const routine = { id: "r", name: "Cutouts", appId: "photoshop", inputs: [{ key: "photos", label: "Photos", type: "fileList", required: true }], outputs: [], settings: [], iterate: { input: "photos" } } as unknown as Routine;
    const flow = {
      nodes: [
        { id: "in", kind: "input", port: { key: "photos", label: "Photos", type: "fileList", required: true }, position: { x: 0, y: 0 } },
        { id: "r", kind: "routine", routineId: "r", routineVersion: 1, position: { x: 0, y: 0 } },
      ],
      edges: [{ id: "e", from: { nodeId: "in", port: "photos" }, to: { nodeId: "r", port: "photos" } }],
    } as unknown as Flow;
    const report = await preflight(flow, { routines: { r: routine }, stageKind: () => "script" }, { in: dir });
    expect(report.skipped.map((n) => n.text)).toEqual([expect.stringMatching(/^broken\.jpg isn't a readable image.*It will be skipped\.$/)]);
    expect(report.notes?.map((n) => n.text)).toEqual([
      "cmyk.jpg is a CMYK image. PNG and Figma results are RGB, so colors can shift a little.",
      "Very large: huge.png (10000 × 10000 px). It will be slow and make big files.",
    ]);
    expect(report.needs).toEqual([]);
    // InDesign keeps CMYK for print: no note.
    const indesign = await preflight(flow, { routines: { r: { ...routine, appId: "indesign" } }, stageKind: () => "script" }, { in: dir });
    expect(indesign.notes?.map((n) => n.text)).toEqual([expect.stringMatching(/^Very large/)]);
  });
});
