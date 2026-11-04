import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../electron/adapters/registry";
import type { DesignAppAdapter, StageItemInput, StageRunContext } from "../electron/adapters/types";
import { validateFlow } from "../electron/core/flows/validateFlow";
import type { AiAccessService } from "../electron/core/services/aiAccessService";
import { PLAN_FORMAT_EXAMPLE } from "../electron/core/services/aiPrompts";
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

// Creation end to end with a scripted AI and two fake apps: one routine (whose fields come out under near-miss
// names, as Meta's alphabetical order made them), and a flow: plan, confirm, a Photoshop routine, then a Figma
// routine that pairs each data row with the cutout the first one made in its trial.

let dir: string;
const matchedFiles: string[] = [];
/** What the fake Figma was asked to run, per item. */
const figmaActions: Record<string, any>[][] = [];
/** What the reviewer was told about a sampled trial. */
let reviewedSample: unknown;

function fakeApp(id: "figma" | "photoshop"): DesignAppAdapter {
  return {
    id,
    name: id === "figma" ? "Figma" : "Adobe Photoshop",
    stageKind: id === "figma" ? "actions" : "script",
    qcChecks: [],
    capabilityManifest: () => `${id} guide`,
    getAppVersion: async () => (id === "photoshop" ? "27.0" : null),
    listOpenDocuments: async () => (id === "figma" ? [{ id: "figma:doc1", appId: "figma", name: "Cards", active: true }] : []),
    inspectForModel: async () => ({ frames: [{ name: "Card" }] }),
    beginStage: async () => ({ state: {} }),
    endStage: async () => undefined,
    endRun: async () => undefined,
    async runStageItem(_s: unknown, input: StageItemInput, ctx: StageRunContext) {
      await fs.mkdir(ctx.workDir, { recursive: true });
      if (id === "photoshop") {
        const item = input.item as { stem: string };
        const file = path.join(ctx.workDir, `${item.stem}.png`);
        await fs.writeFile(file, "png");
        return { ok: true, outputs: [{ key: `${input.key}-1`, label: path.basename(file), filePath: file }], values: { cutouts: [file] }, findings: [], log: [] };
      }
      const actions = (input.body as { actions: Record<string, any>[] }).actions;
      figmaActions.push(actions);
      const image = actions.find((a) => a.action === "setImageFill")?.image?.file;
      if (image) matchedFiles.push(path.basename(image));
      const title = (input.item as { title?: string } | null)?.title ?? "card";
      const file = path.join(ctx.workDir, `${title}.png`);
      await fs.writeFile(file, "png");
      const key = ctx.stage.outputs[0]?.key ?? "files";
      return { ok: true, outputs: [{ key: `${input.key}-1`, label: path.basename(file), filePath: file }], values: { [key]: [file] }, findings: [], log: [] };
    },
  } as unknown as DesignAppAdapter;
}

const cutoutRoutine = {
  name: "Cut out photos",
  app: "photoshop",
  inputs: [{ key: "photos", label: "Photos", type: "fileList", required: true, extensions: ["jpg"] }],
  iterate: { input: "photos" },
  outputs: [{ key: "cutouts", label: "Cutouts", type: "fileList", required: true, extensions: ["png"] }],
  settings: [],
  steps: ["Removes the background"],
  script: 'var img = openDocument(ctx.item.path);\nctx.output("cutouts", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png"));',
};

const labelActions = JSON.stringify([
  { action: "duplicateNode", id: "card", node: "Card" },
  { action: "setText", node: "$card.#Title", text: "{{item.title}}" },
  { action: "setImageFill", node: "$card.#Photo", image: { file: "{{matched.cutouts}}" } },
  { action: "exportNode", node: "$card", format: "PNG", fileName: "{{item.title}}", output: "labels" },
]);

const labelRoutine = {
  name: "Fill labels",
  app: "figma",
  inputs: [
    { key: "file", label: "Figma file", type: "document", required: true },
    { key: "products", label: "Products", type: "rows", required: true, columns: ["title", "photo"] },
    { key: "cutouts", label: "Cutouts", type: "fileList", required: true, extensions: ["png"] },
  ],
  iterate: { input: "products" },
  outputs: [{ key: "labels", label: "Labels", type: "fileList", required: true, extensions: ["png"] }],
  settings: [],
  steps: ["Fills a label per product"],
  // Under Meta's alphabetical field order, "actions" came out like this.
  "actionsروس": "",
  actions_O: labelActions,
};

const exportRoutine = {
  name: "Export screens",
  app: "figma",
  inputs: [{ key: "file", label: "Figma file", type: "document", required: true }],
  outputs: [{ key: "screens", label: "Screens", type: "fileList", required: true, extensions: ["png"] }],
  settings: [],
  steps: ["Exports the screens at 2x"],
  actions: JSON.stringify(["a", "b", "c", "d", "e"].map((frame) => ({ action: "exportNode", node: frame, format: "PNG", scale: 2, fileName: frame, output: "screens" }))),
};
const exportsIn = (actions: Record<string, any>[]) => actions.filter((a) => a.action === "exportNode").map((a) => a.node);

/** A test's own AI answers for routine turns, in place of the scripted ones. */
let answers: ((messages: ChatMessage[]) => Record<string, unknown>) | null = null;

function scriptedAi(log: string[]): AiService {
  let figmaProposals = 0;
  return {
    async turn(messages: ChatMessage[], schema, _actions, ctx) {
      ctx.onAiCall();
      if (answers) return answers(messages);
      const system = String(messages[0].content);
      if (schema.name === "doppl_plan_turn") {
        log.push("plan");
        return { action: "propose_plan", plan: JSON.parse(JSON.stringify(PLAN_FORMAT_EXAMPLE)), reason: "Plan the flow" };
      }
      if (system.includes('(app id "photoshop")')) {
        log.push("photoshop");
        return { action: "propose_routine", reason: "Cut out", routine: cutoutRoutine };
      }
      figmaProposals++;
      log.push(`figma ${figmaProposals}`);
      // First proposal forgets the iterate field; Doppl sends the problem back.
      const routine = figmaProposals === 1 ? { ...labelRoutine, iterate: undefined } : labelRoutine;
      return { "action": "propose_routine", "reason": "Fill labels", "routine_x": routine };
    },
    reviewTrial: async (_task, draft) => {
      reviewedSample = draft.exportSample;
      return {};
    },
    reviewOutput: async () => ({ level: "visual", label: "AI visual review", passed: true }),
    checkObjectInRegion: async () => ({ level: "object", label: "x", passed: true }),
  };
}

let service: RoutineService;
let flows: FlowService;
let library: LibraryService;
let aiLog: string[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-create-"));
  matchedFiles.length = 0;
  figmaActions.length = 0;
  reviewedSample = undefined;
  aiLog = [];
  answers = null;
  const registry = new AdapterRegistry([fakeApp("photoshop"), fakeApp("figma")]);
  const storage = new JsonStorage(path.join(dir, "data"));
  const starters = new StarterService(path.join(dir, "starters"));
  await starters.load();
  library = new LibraryService({ storage, starters });
  flows = new FlowService({ storage, library, starters, registry });
  const ai = scriptedAi(aiLog);
  service = new RoutineService({
    storage,
    registry,
    library,
    flows,
    ai,
    access: { ensureReady: async () => undefined, provider: () => "meta-api", noteQuota: () => undefined } as unknown as AiAccessService,
    qc: new QcService(ai),
    apps: { statusOf: async () => "connected" } as unknown as AppStatusService,
    emit: () => undefined,
    workRoot: path.join(dir, "work"),
    templates: [],
  });
  await fs.writeFile(path.join(dir, "products.csv"), "title,photo\nApricot,apricot.jpg\nFig,fig.jpg\n");
  for (const name of ["apricot.jpg", "fig.jpg"]) await fs.writeFile(path.join(dir, name), "jpg");
});

async function until(id: string, done: (c: Creation) => boolean): Promise<Creation> {
  for (let i = 0; i < 400; i++) {
    const c = service.getCreation(id)!;
    if (done(c)) return c;
    if (c.status === "failed") throw new Error(`Creation failed: ${c.error?.message} ${c.error?.detail ?? ""}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
}

describe("creating with the AI", () => {
  it("creates one routine with a contract, recovering near-miss field names and fixing what the validator found", async () => {
    const c = await service.create({
      request: "Fill a card per product",
      references: [path.join(dir, "products.csv"), path.join(dir, "apricot.png")],
      appId: "figma",
      apps: [{ appId: "figma" }],
    });
    await fs.writeFile(path.join(dir, "apricot.png"), "png");
    const ready = await until(c.id, (x) => x.status === "ready");
    expect(aiLog).toEqual(["figma 1", "figma 2"]);
    expect(ready.activity?.some((a) => a.includes("only exists in a routine that iterates"))).toBe(true);
    expect(ready.draft).toMatchObject({ appId: "figma", iterate: { input: "products" }, matches: { cutouts: expect.any(Object) } });
    expect(ready.draft!.actions).toHaveLength(4);
    expect(ready.trial).toMatchObject({ status: "done", total: 1 });
    const saved = await service.save(c.id, { name: "Product cards" });
    expect(saved.routine).toMatchObject({ name: "Product cards", version: 1, createdWithAiCalls: 2, format: 2 });
    expect((await library.list()).map((r) => r.name)).toEqual(["Product cards"]);
  });

  it("tries a sample of a long export list, says so to the AI, the reviewer and the designer, and keeps every export", async () => {
    const seen: string[] = [];
    answers = (messages) => {
      seen.push(JSON.stringify(messages));
      return seen.length === 1 ? { action: "preview_routine", reason: "Try it", routine: exportRoutine } : { action: "propose_routine", reason: "Done", routine: exportRoutine };
    };
    const c = await service.create({ request: "Export the screens at 2x", references: [], appId: "figma", apps: [{ appId: "figma" }] });
    const ready = await until(c.id, (x) => x.status === "ready");

    expect(figmaActions.length).toBeGreaterThan(1);
    for (const actions of figmaActions) {
      expect(exportsIn(actions)).toEqual(["a", "e"]);
      expect(actions.filter((a) => a.action === "inspectNode").map((a) => a.node)).toEqual(["b", "c", "d"]);
    }
    expect(seen[1]).toContain("only 2 of the 5 exports");
    expect(reviewedSample).toEqual({ tried: 2, total: 5 });
    expect(ready.trialExports).toEqual({ tried: 2, total: 5 });
    expect(JSON.stringify(ready.stages)).toContain("2 of 5 exports tried");

    expect(exportsIn(ready.draft!.actions!)).toEqual(["a", "b", "c", "d", "e"]);
    const saved = await service.save(c.id, { name: "Screens" });
    expect(exportsIn(saved.routine!.actions!)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("tries every export when changing a routine, since the change may be about any of them", async () => {
    answers = () => ({ action: "propose_routine", reason: "Done", routine: exportRoutine });
    const c = await service.create({ request: "Export the screens at 2x", references: [], appId: "figma", apps: [{ appId: "figma" }] });
    await until(c.id, (x) => x.status === "ready");
    const saved = await service.save(c.id, { name: "Screens" });

    figmaActions.length = 0;
    answers = () => ({ action: "propose_routine", reason: "Rename", changeSummary: "Renames the files", routine: exportRoutine });
    const change = await service.refine({ routineId: saved.routine!.id, request: "Name frame c differently", images: [], testItems: [] });
    for (let i = 0; i < 400 && !figmaActions.length; i++) await new Promise((r) => setTimeout(r, 5));
    await service.cancel(change.id);

    expect(figmaActions.length).toBeGreaterThan(0);
    for (const actions of figmaActions) expect(exportsIn(actions)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("says when a request isn't a task instead of inventing a routine, after an answer in the designer's own words", async () => {
    const seen: string[] = [];
    answers = (messages) => {
      seen.push(String(messages[messages.length - 1].content));
      return seen.length === 1
        ? { action: "ask_question", question: { text: "What should the routine do?", options: [{ id: "a", label: "Export the frames" }, { id: "b", label: "Something else — I'll describe it" }] } }
        : { action: "decline", reason: "This is a greeting, not design work to automate." };
    };
    const c = await service.create({ request: "How are you?", references: [], appId: "figma", apps: [{ appId: "figma" }] });
    const asked = await until(c.id, (x) => x.status === "waiting" && !!x.question);
    service.answer(c.id, asked.question!.id, "Nothing, I was just saying hi");
    for (let i = 0; i < 400 && service.getCreation(c.id)!.status !== "failed"; i++) await new Promise((r) => setTimeout(r, 5));
    const failed = service.getCreation(c.id)!;
    expect(seen[1]).toContain("Answer: Nothing, I was just saying hi.");
    expect(failed.error).toMatchObject({ kind: "not-a-task", message: "This is a greeting, not design work to automate." });
    expect(failed.canContinue).toBe(false);
    expect(await library.list()).toEqual([]);
  });

  it("lets the AI ask a follow-up question when the first answer left it open, but no third", async () => {
    const seen: string[] = [];
    const question = (text: string) => ({ action: "ask_question", question: { text, options: [{ id: "a", label: "PNG" }, { id: "b", label: "PDF" }] } });
    answers = (messages) => {
      seen.push(String(messages[messages.length - 1].content));
      return seen.length <= 3 ? question(`Question ${seen.length}`) : { action: "decline", reason: "Stop here." };
    };
    const c = await service.create({ request: "Export the cards", references: [], appId: "figma", apps: [{ appId: "figma" }] });
    for (const n of [1, 2]) {
      const asked = await until(c.id, (x) => x.status === "waiting" && x.question?.text === `Question ${n}`);
      service.answer(c.id, asked.question!.id, "a");
    }
    for (let i = 0; i < 400 && service.getCreation(c.id)!.status !== "failed"; i++) await new Promise((r) => setTimeout(r, 5));
    expect(seen[3]).toContain("Don't ask now.");
    // Work under way isn't dropped by a late decline.
    expect(seen[4]).toContain("Don't decline now: propose the routine.");
  });

  it("asks for missing sample files instead of failing, then goes on without asking the AI again", async () => {
    const c = await service.create({
      request: "Cut out the product photos in a folder",
      references: [],
      appId: "photoshop",
      apps: [{ appId: "photoshop", noDocument: true }],
    });
    const waiting = await until(c.id, (x) => x.status === "waiting");
    expect(waiting.needs).toEqual({
      kind: "samples",
      message: "Doppl needs sample “Photos” to try this routine. Attach them to go on; the AI's work so far is kept.",
      inputs: [{ key: "photos", label: "Photos", type: "fileList", extensions: ["jpg"] }],
    });
    expect(waiting.stages.find((s) => s.key === "run")).toMatchObject({ status: "active", detail: "Waiting for sample files" });
    // From two places: a folder of notes (fills nothing) and the photos; the designer removes the first and goes on.
    const notes = path.join(dir, "notes");
    await fs.mkdir(notes);
    await fs.writeFile(path.join(notes, "todo.txt"), "x");
    const photos = path.join(dir, "photos");
    await fs.mkdir(photos);
    await fs.writeFile(path.join(photos, "plum.jpg"), "jpg");
    await service.addSamples(c.id, { files: [], folders: [notes] });
    const added = await service.addSamples(c.id, { files: [], folders: [photos] });
    expect(added.status).toBe("waiting");
    expect(added.needs!.added).toEqual([
      { path: notes, isFolder: true, fills: [] },
      { path: photos, isFolder: true, fills: [{ key: "photos", label: "Photos", count: 1 }] },
    ]);
    await service.removeSample(c.id, notes);
    await service.confirmSamples(c.id);
    const ready = await until(c.id, (x) => x.status === "ready");
    expect(ready.needs).toBeUndefined();
    expect(aiLog).toEqual(["photoshop"]);
    expect(ready.aiCalls).toBe(1);
    expect(ready.trial).toMatchObject({ status: "done", total: 1, items: [expect.objectContaining({ label: "plum.jpg" })] });
    expect(ready.task.folders).toEqual([photos]);
  });

  it("stops waiting for samples when cancelled, and can continue later", async () => {
    const c = await service.create({ request: "Cut out photos", references: [], appId: "photoshop", apps: [{ appId: "photoshop", noDocument: true }] });
    await until(c.id, (x) => x.status === "waiting");
    await service.cancel(c.id);
    const cancelled = service.getCreation(c.id)!;
    expect(cancelled).toMatchObject({ status: "cancelled", canContinue: true });
    expect(cancelled.needs).toBeUndefined();
  });

  it("plans a flow across apps, waits for confirmation, creates each routine in order, and saves the flow", async () => {
    const c = await service.create({
      request: "Cut out the photos, then make a label per product",
      references: [path.join(dir, "products.csv"), path.join(dir, "apricot.jpg"), path.join(dir, "fig.jpg")],
      appId: "photoshop",
      apps: [{ appId: "photoshop", noDocument: true }, { appId: "figma" }],
    });
    const planned = await until(c.id, (x) => x.status === "waiting" && !!x.plan);
    expect(planned.kind).toBe("flow");
    expect(planned.flowRoutines!.map((r) => [r.id, r.status])).toEqual([
      ["cutouts", "pending"],
      ["labels", "pending"],
    ]);
    expect(await library.list()).toEqual([]);

    await service.confirmPlan(c.id);
    const saved = await until(c.id, (x) => x.status === "saved");
    expect(aiLog).toEqual(["plan", "photoshop", "figma 1", "figma 2"]);
    // The Figma trial (its first proposal didn't pass validation, so it ran once) got the cutout the Photoshop
    // trial made for the same row, through the plan's match rule.
    expect(matchedFiles).toEqual(["apricot.png"]);
    expect(saved.flowRoutines!.map((r) => [r.id, r.status, r.aiCalls])).toEqual([
      ["cutouts", "saved", 1],
      ["labels", "saved", 2],
    ]);
    const flow = (await flows.get(saved.savedFlowId!))!;
    expect(flow).toMatchObject({ name: "Product labels", createdWithAiCalls: 4, version: 1 });
    expect(flow.nodes.map((n) => n.id)).toEqual(["input-products", "input-photos", "node-cutouts", "node-labels", "output-labels"]);
    expect(flow.edges.find((e) => e.to.port === "cutouts")!.match).toEqual({ by: "fileNameEqualsColumn", column: "photo", ignoreExtension: true, loose: true });
    const ctx = await flows.context(flow);
    expect(ctx.validation).toEqual({ ok: true, issues: [] });
    const routines = await library.list();
    expect(routines.map((r) => [r.name, r.appId, r.createdWithAiCalls]).sort()).toEqual([
      ["Cut out photos", "photoshop", 1],
      ["Fill labels", "figma", 2],
    ]);
  });
});
