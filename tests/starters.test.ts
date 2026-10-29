import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { LibraryService } from "../electron/core/services/libraryService";
import { StarterService, toStarterFile } from "../electron/core/services/starterService";
import { JsonStorage } from "../electron/core/services/storage";
import type { Routine } from "../electron/core/types";

// Starters here are test fixtures written to a temporary folder; Doppl itself ships none.

const routine = (extra: Partial<Routine> = {}): Routine => ({
  id: "r1",
  name: "Resize to PNG",
  appId: "photoshop",
  description: "Saves each image from /Users/ana/Desktop/brief as a PNG.",
  steps: [{ id: "s", plainLanguage: "Opens each image" }],
  inputs: [{ key: "images", label: "Images", type: "fileList", required: true, extensions: ["jpg"] }],
  outputs: [{ key: "pngs", label: "PNGs", type: "fileList", required: true, extensions: ["png"] }],
  settings: [
    { key: "width", label: "Width", type: "number", required: false, default: 1200 },
    { key: "watermark", label: "Watermark file", type: "text", required: false, default: "/Users/ana/Assets/mark.png" },
  ],
  iterate: { input: "images" },
  kind: "script",
  script: 'var img = openDocument(ctx.item.path);\nctx.output("pngs", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png"));',
  version: 3,
  createdWithAiCalls: 7,
  appVersion: "27.0",
  requiredFonts: [],
  runs: [{ id: "run", startedAt: "", status: "succeeded", inputsSummary: "brief", qcStatus: "pass", outputCount: 2, flaggedCount: 0, aiCalls: 0, routineVersion: 3 }],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  versions: [{ version: 3, createdAt: "", aiCalls: 7, note: "Created from “resize Ana's client photos for Acme”" }],
  modifiesDocument: false,
  qcProfile: "web",
  format: 2,
  ...extra,
});

let dir: string;
let starters: StarterService;
let library: LibraryService;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-starters-"));
  await fs.mkdir(path.join(dir, "starters", "older"), { recursive: true });
  const { starter } = toStarterFile(routine(), { converter: true });
  await fs.writeFile(path.join(dir, "starters", "resize.json"), JSON.stringify({ ...starter, version: 2 }));
  await fs.writeFile(path.join(dir, "starters", "older", "resize-1.json"), JSON.stringify({ ...starter, version: 1, name: "Resize (old)" }));
  await fs.writeFile(path.join(dir, "starters", "broken.json"), "{ nope");
  await fs.writeFile(path.join(dir, "starters", "not-a-routine.json"), JSON.stringify({ hello: "world" }));
  starters = new StarterService(path.join(dir, "starters"));
  await starters.load();
  library = new LibraryService({ storage: new JsonStorage(path.join(dir, "data")), starters });
});

describe("starter routines", () => {
  it("load read-only from the app's resources, newest version first, older versions kept", async () => {
    const list = starters.list();
    expect(list.map((r) => [r.id, r.version, r.name])).toEqual([["starter-resize-to-png", 2, "Resize to PNG"]]);
    expect(list[0].starter).toEqual({ tags: ["converter"] });
    expect(starters.getVersion("starter-resize-to-png", 1)!.name).toBe("Resize (old)");
    expect(await library.getVersion("starter-resize-to-png", 1)).toMatchObject({ version: 1 });
    expect(starters.converters()).toHaveLength(1);
    await expect(library.save(list[0])).rejects.toThrow("Starter routines are read-only");
  });

  it("duplicate into my routines, independent from later starter updates", async () => {
    const copy = await library.duplicate("starter-resize-to-png");
    expect(copy.id).not.toBe("starter-resize-to-png");
    expect(copy).toMatchObject({ version: 1, duplicatedFrom: { routineId: "starter-resize-to-png", version: 2 }, runs: [] });
    expect(copy.starter).toBeUndefined();
    expect(await library.list()).toHaveLength(1);
    // The starter changes in a new app version; the copy stays as it was.
    const { starter } = toStarterFile(routine({ name: "Resize to PNG", script: routine().script.replace("png", "png") }), { converter: true });
    await fs.writeFile(path.join(dir, "starters", "resize.json"), JSON.stringify({ ...starter, version: 3, description: "Changed" }));
    await starters.load();
    expect(starters.get("starter-resize-to-png")!.version).toBe(3);
    expect((await library.get(copy.id))!.description).toBe(copy.description);
  });

  it("export strips run history, request notes and locations on this Mac", () => {
    const { starter, removed } = toStarterFile(routine(), { converter: false });
    expect(starter).toMatchObject({ id: "starter-resize-to-png", version: 1, createdWithAiCalls: 0, runs: [], starter: { tags: [] } });
    expect(starter.versions).toEqual([{ version: 1, createdAt: expect.any(String), aiCalls: 0, note: "Made by Doppl" }]);
    expect(starter.settings.find((s) => s.key === "watermark")!.default).toBeUndefined();
    expect(starter.settings.find((s) => s.key === "width")!.default).toBe(1200);
    expect(starter.description).toBe("Saves each image from … as a PNG.");
    expect(JSON.stringify(starter)).not.toMatch(/\/Users\/|Acme/);
    expect(removed).toEqual(expect.arrayContaining(["run history (1 run)", "the default of “Watermark file” (a location on this Mac)", "a location on this Mac in the description"]));
  });

  it("export refuses a routine whose body points at this Mac", () => {
    expect(() => toStarterFile(routine({ script: 'openDocument("/Users/ana/x.psd");' }), { converter: false })).toThrow("points to a fixed location");
  });
});
