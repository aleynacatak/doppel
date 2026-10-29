import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../electron/adapters/registry";
import type { DesignAppAdapter, StageItemInput, StageRunContext } from "../electron/adapters/types";
import type { AiAccessService } from "../electron/core/services/aiAccessService";
import type { AiService } from "../electron/core/services/aiService";
import type { AppStatusService } from "../electron/core/services/appStatusService";
import type { ChatMessage } from "../electron/core/services/aiTransport";
import { FlowService } from "../electron/core/services/flowService";
import { LibraryService } from "../electron/core/services/libraryService";
import { QcService } from "../electron/core/services/qcService";
import { RoutineService } from "../electron/core/services/routineService";
import { StarterService } from "../electron/core/services/starterService";
import { JsonStorage } from "../electron/core/services/storage";
import type { Creation } from "../electron/core/types";

// The input check in a creation, with a scripted AI and a fake Figma: a product list and a folder of flavor images
// that the designer named loosely, where the first row has no image. Doppl asks before the AI starts, tells the AI
// what was decided, and tries a row that has its image.

let dir: string;
let service: RoutineService;
let firstMessages: string[];
let placed: string[];

const routine = {
  name: "Flavor labels",
  app: "figma",
  inputs: [
    { key: "file", label: "Figma file", type: "document", required: true },
    { key: "products", label: "Products", type: "rows", required: true, columns: ["Flavor"] },
    { key: "images", label: "Flavor images", type: "fileList", required: true, extensions: ["png"] },
  ],
  iterate: { input: "products" },
  outputs: [{ key: "labels", label: "Labels", type: "fileList", required: true, extensions: ["png"] }],
  settings: [],
  steps: ["Fills a label per flavor"],
  actions: JSON.stringify([
    { action: "duplicateNode", id: "card", node: "Card" },
    { action: "setText", node: "$card.#Title", text: "{{item.Flavor}}" },
    { action: "setImageFill", node: "$card.#Photo", image: { file: "{{matched.images}}" } },
    { action: "exportNode", node: "$card", format: "PNG", fileName: "{{item.Flavor}}", output: "labels" },
  ]),
};

const figma = {
  id: "figma",
  name: "Figma",
  stageKind: "actions",
  qcChecks: [],
  capabilityManifest: () => "figma guide",
  getAppVersion: async () => null,
  listOpenDocuments: async () => [{ id: "figma:doc1", appId: "figma", name: "Labels", active: true }],
  inspectForModel: async () => ({ frames: [{ name: "Card" }] }),
  beginStage: async () => ({ state: {} }),
  endStage: async () => undefined,
  endRun: async () => undefined,
  async runStageItem(_s: unknown, input: StageItemInput, ctx: StageRunContext) {
    const actions = (input.body as { actions: Record<string, any>[] }).actions;
    placed.push(path.basename(String(actions.find((a) => a.action === "setImageFill")?.image?.file ?? "")));
    await fs.mkdir(ctx.workDir, { recursive: true });
    const file = path.join(ctx.workDir, `${input.label}.png`);
    await fs.writeFile(file, "png");
    return { ok: true, outputs: [{ key: `${input.key}-1`, label: path.basename(file), filePath: file }], values: { labels: [file] }, findings: [], log: [] };
  },
} as unknown as DesignAppAdapter;

const ai: AiService = {
  async turn(messages: ChatMessage[], _schema, _actions, ctx) {
    ctx.onAiCall();
    firstMessages.push(String(messages[1]?.content ?? ""));
    return { action: "propose_routine", reason: "Fill labels", routine };
  },
  reviewTrial: async () => ({}),
  reviewOutput: async () => ({ level: "visual", label: "AI visual review", passed: true }),
  checkObjectInRegion: async () => ({ level: "object", label: "x", passed: true }),
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-inputs-create-"));
  firstMessages = [];
  placed = [];
  const registry = new AdapterRegistry([figma]);
  const storage = new JsonStorage(path.join(dir, "data"));
  const starters = new StarterService(path.join(dir, "starters"));
  await starters.load();
  const library = new LibraryService({ storage, starters });
  const flows = new FlowService({ storage, library, starters, registry });
  service = new RoutineService({
    storage,
    registry,
    library,
    flows,
    ai,
    access: { ensureReady: async () => undefined, provider: () => "meta-api", noteQuota: () => undefined } as unknown as AiAccessService,
    qc: new QcService(ai),
    getStyle: async () => null,
    apps: { statusOf: async () => "connected" } as unknown as AppStatusService,
    emit: () => undefined,
    workRoot: path.join(dir, "work"),
    templates: [],
  });
  await fs.mkdir(path.join(dir, "flavor pics"));
  for (const name of ["Strawberry_Vanilla.PNG", "mango-label.jpg", "old.png"]) await fs.writeFile(path.join(dir, "flavor pics", name), "img");
});

async function until(id: string, done: (c: Creation) => boolean): Promise<Creation> {
  for (let i = 0; i < 400; i++) {
    const c = service.getCreation(id)!;
    if (done(c)) return c;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out (${service.getCreation(id)?.status}: ${service.getCreation(id)?.error?.message ?? ""})`);
}

const start = (csv: string) =>
  fs.writeFile(path.join(dir, "products.csv"), csv).then(() =>
    service.create({ request: "Make a label for each flavor", references: [path.join(dir, "products.csv")], folders: [path.join(dir, "flavor pics")], appId: "figma", apps: [{ appId: "figma" }] }),
  );

describe("the input check in a creation", () => {
  it("asks how rows find their images and what to do without one, before any AI call, then follows the answers", async () => {
    const c = await start("Flavor,Price\nFig,5\nStrawberry Vanilla,4\nMango,3\n");
    const pairing = structuredClone(await until(c.id, (x) => x.status === "waiting"));
    expect(pairing.question).toMatchObject({ kind: "inputs", text: "How should each row in products.csv find its image in flavor pics?", detail: "3 rows · 3 images (PNG, JPG)" });
    expect(pairing.question!.options[0]).toEqual({ id: "column:Flavor", label: "By “Flavor”", detail: "Strawberry Vanilla → Strawberry_Vanilla.PNG · Mango → mango-label.jpg · 2 of 3 have one" });
    expect(firstMessages).toEqual([]);
    await service.answer(c.id, pairing.question!.id, "column:Flavor");

    const missing = await until(c.id, (x) => x.status === "waiting" && x.question?.id !== pairing.question!.id);
    expect(missing.question!.text).toBe("1 of 3 rows has no image in flavor pics: Fig. What should Doppl do with it?");
    await service.answer(c.id, missing.question!.id, "without");

    const ready = await until(c.id, (x) => x.status === "ready");
    expect(firstMessages[0]).toContain("Inputs Doppl checked");
    expect(firstMessages[0]).toContain('pairs with its image in flavor pics by its "Flavor" value');
    expect(firstMessages[0]).toContain("Fig has no image: make it without it");
    expect(firstMessages[0]).toContain("Accept every one of these formats");
    // Row 1 (Fig) has no image: the trial uses Strawberry Vanilla, with its own image.
    expect(ready.activity).toContain("Tried on Row 2 · Strawberry Vanilla: the first item has no partner");
    expect(placed).toEqual(["Strawberry_Vanilla.PNG"]);
    expect(ready.draft!.matches).toEqual({ images: { by: "fileNameEqualsColumn", column: "Flavor", ignoreExtension: true, loose: true, optional: true } });
    // The folder has a JPG: the input takes it too.
    expect(ready.draft!.inputs.find((p) => p.key === "images")!.extensions).toEqual(["png", "jpg"]);
  });

  it("stops before the AI when the designer wants to add the missing files", async () => {
    const c = await start("Flavor\nFig\nMango\n");
    const pairing = structuredClone(await until(c.id, (x) => x.status === "waiting"));
    await service.answer(c.id, pairing.question!.id, pairing.question!.options[0].id);
    const missing = await until(c.id, (x) => x.status === "waiting" && x.question?.id !== pairing.question!.id);
    await service.answer(c.id, missing.question!.id, "stop");
    const failed = await until(c.id, (x) => x.status === "failed");
    expect(failed.error!.message).toBe("Add the missing images to flavor pics, then try again. Nothing was sent to the AI yet.");
    expect(failed.aiCalls).toBe(0);
  });

  it("asks which file an item's partner is when a trial fails on the files, instead of asking the AI", async () => {
    await fs.writeFile(path.join(dir, "products.csv"), "Flavor,image\nStrawberry Vanilla,strawberry-vanilla.png\n");
    const c = await service.create({ request: "Make a label for each flavor", references: [path.join(dir, "products.csv")], appId: "figma", apps: [{ appId: "figma" }] });
    // No pictures yet: Doppl asks for samples, and the designer adds a folder with a file named differently.
    await until(c.id, (x) => x.status === "waiting" && x.needs?.kind === "samples");
    await fs.mkdir(path.join(dir, "camera"));
    await fs.writeFile(path.join(dir, "camera", "IMG_2041.png"), "img");
    await service.addSamples(c.id, { files: [], folders: [path.join(dir, "camera")] });
    const asked = structuredClone(await until(c.id, (x) => x.status === "waiting" && !!x.question));
    expect(asked.question).toMatchObject({
      kind: "inputs",
      text: "No flavor image matches “strawberry-vanilla.png” for Strawberry Vanilla. Which file is it?",
      options: [
        { id: "file:IMG_2041.png", label: "IMG_2041.png" },
        { id: "add", label: "I'll add the flavor image" },
      ],
    });
    await service.answer(c.id, asked.question!.id, "file:IMG_2041.png");
    const ready = await until(c.id, (x) => x.status === "ready");
    expect(placed).toEqual(["IMG_2041.png"]);
    expect(firstMessages).toHaveLength(1);
    expect(ready.draft!.matches!.images.pairs).toEqual({ "strawberry vanilla png": "IMG_2041.png" });
  });

  it("doesn't ask when every row finds its image", async () => {
    const c = await start("Flavor\nStrawberry Vanilla\nMango\nOld\n");
    const ready = await until(c.id, (x) => x.status === "ready" || x.status === "waiting");
    expect(ready.status).toBe("ready");
    expect(ready.activity).toContain("Paired products.csv with flavor pics: by “flavor” (3 of 3)");
    expect(placed).toEqual(["Strawberry_Vanilla.PNG"]);
  });
});
