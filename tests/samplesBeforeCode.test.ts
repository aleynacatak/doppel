import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../electron/adapters/registry";
import type { DesignAppAdapter, StageItemInput, StageRunContext } from "../electron/adapters/types";
import type { AiAccessService } from "../electron/core/services/aiAccessService";
import type { AiService } from "../electron/core/services/aiService";
import type { ChatMessage } from "../electron/core/services/aiTransport";
import type { AppStatusService } from "../electron/core/services/appStatusService";
import { FlowService } from "../electron/core/services/flowService";
import { LibraryService } from "../electron/core/services/libraryService";
import { QcService } from "../electron/core/services/qcService";
import { RoutineService } from "../electron/core/services/routineService";
import { StarterService } from "../electron/core/services/starterService";
import { JsonStorage } from "../electron/core/services/storage";
import type { Creation } from "../electron/core/types";

// A routine's sample files come before its code: Doppl asks for the missing ones at the first proposal, and the AI sees
// a template's text and a data file's first rows before it writes anything. Found on business cards, Nov 4: the AI
// assumed {{column}} marks in a template it never saw, and the cards kept the template's own text.

let dir: string;
let service: RoutineService;
let calls: { kind: "turn" | "code"; messages: ChatMessage[] }[];
let read: string[];
let readFile: (file: string) => Promise<unknown>;
/** The AI's answers for planner turns, in order; the routine when the list runs out. */
let turns: Record<string, unknown>[];
/** What the coder writes. */
let code: string;
/** The reviewer: a result of { missed: true } sends the first output back. */
let review: () => Record<string, unknown>;

const TEMPLATE_TEXT = { pageCount: 1, textFrames: [{ where: "page 1", text: "Name Surname" }] };

const routine = {
  name: "Business cards",
  app: "indesign",
  inputs: [
    { key: "template", label: "Card template", type: "file", required: true, extensions: ["indd"] },
    { key: "contacts", label: "Contacts", type: "rows", required: true },
  ],
  outputs: [{ key: "pdf", label: "Print PDF", type: "file", required: true, extensions: ["pdf"] }],
  settings: [],
  steps: ["Fills one card per row"],
  script: "@code:1",
};

function fakeInDesign(): DesignAppAdapter {
  return {
    id: "indesign",
    name: "Adobe InDesign",
    stageKind: "script",
    qcChecks: [],
    capabilityManifest: () => "indesign guide",
    lintScript: () => [],
    getAppVersion: async () => "21.6",
    listOpenDocuments: async () => [],
    inspectForModel: async () => ({}),
    readFileForModel: async (file: string) => {
      read.push(path.basename(file));
      return /\.indd$/.test(file) ? readFile(file) : null;
    },
    beginStage: async () => ({ state: {} }),
    endStage: async () => undefined,
    endRun: async () => undefined,
    async runStageItem(_s: unknown, input: StageItemInput, ctx: StageRunContext) {
      await fs.mkdir(ctx.workDir, { recursive: true });
      const file = path.join(ctx.workDir, "cards.pdf");
      await fs.writeFile(file, "pdf");
      return { ok: true, outputs: [{ key: `${input.key}-pdf-1`, label: "cards.pdf", filePath: file }], values: { pdf: [file] }, findings: [], log: [] };
    },
  } as unknown as DesignAppAdapter;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-samples-"));
  calls = [];
  read = [];
  readFile = async () => TEMPLATE_TEXT;
  turns = [];
  review = () => ({});
  code = 'var d = ctx.open(params.template);\nvar f = ctx.exportPdf(d, ctx.workDir + "/cards.pdf", {});\nctx.close(d);\nctx.output({ key: "pdf", label: "Print PDF", filePath: f.fsName });';
  const registry = new AdapterRegistry([fakeInDesign()]);
  const storage = new JsonStorage(path.join(dir, "data"));
  const starters = new StarterService(path.join(dir, "starters"));
  await starters.load();
  const library = new LibraryService({ storage, starters });
  const flows = new FlowService({ storage, library, starters, registry });
  const ai: AiService = {
    async turn(messages, _schema, _actions, ctx) {
      ctx.onAiCall();
      calls.push({ kind: "turn", messages: structuredClone(messages) });
      return turns.shift() ?? { action: "propose_routine", reason: "Cards", routine };
    },
    async writeCode(messages, _lang, ctx) {
      ctx.onAiCall();
      calls.push({ kind: "code", messages: structuredClone(messages) });
      return code;
    },
    reviewTrial: async (_task, _draft, outputs) => (review().missed ? { [outputs[0].id]: [{ level: "visual" as const, label: "Review", passed: false, reason: "Not filled" }] } : {}),
    reviewOutput: async () => ({ level: "visual", label: "AI visual review", passed: true }),
    checkObjectInRegion: async () => ({ level: "object", label: "x", passed: true }),
  };
  service = new RoutineService({
    storage,
    registry,
    library,
    flows,
    ai,
    access: { ensureReady: async () => undefined, provider: () => "doppl-demo", refreshSession: async () => ({ ok: true, value: { session: null } }), noteQuota: () => undefined } as unknown as AiAccessService,
    qc: new QcService(ai),
    apps: { statusOf: async () => "connected" } as unknown as AppStatusService,
    emit: () => undefined,
    workRoot: path.join(dir, "work"),
    templates: [],
    options: () => ({ codeFormat: "separate" }),
  });
  await fs.writeFile(path.join(dir, "card.indd"), "indd");
  await fs.writeFile(path.join(dir, "contacts.csv"), "Name,email\nAda,ada@example.com\n");
});

async function until(id: string, done: (c: Creation) => boolean): Promise<Creation> {
  for (let i = 0; i < 400; i++) {
    const c = service.getCreation(id)!;
    if (c.status === "failed") throw new Error(`The creation failed: ${JSON.stringify(c.error)}`);
    if (done(c)) return c;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
}

const text = (m: ChatMessage) => (typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join(""));
const kinds = () => calls.map((c) => c.kind);
const create = (references: string[] = []) => service.create({ request: "Make a business card per row", references, appId: "indesign", apps: [{ appId: "indesign", noDocument: true }] });

describe("sample files before the code", () => {
  it("asks for missing files before any code is written, and shows the AI what they hold", async () => {
    const c = await create();
    const waiting = await until(c.id, (x) => x.status === "waiting" && x.needs?.kind === "samples");
    expect(waiting.needs!.inputs!.map((i) => i.key)).toEqual(["template", "contacts"]);
    expect(kinds()).toEqual(["turn"]);

    await service.addSamples(c.id, { files: [path.join(dir, "card.indd"), path.join(dir, "contacts.csv")], folders: [] });
    await service.confirmSamples(c.id);
    const ready = await until(c.id, (x) => x.status === "ready");
    expect(ready.status).toBe("ready");

    // One more answer from the AI, with the files in view, and only then the code.
    expect(kinds()).toEqual(["turn", "turn", "code"]);
    const told = text(calls[1].messages.at(-1)!);
    expect(told).toContain("Name Surname");
    expect(told).toContain("columns: Name, email");
    expect(told).toContain("ada@example.com");
    expect(text(calls[2].messages.find((m) => text(m).includes("what the sample files hold"))!)).toContain("Name Surname");
  });

  it("shows files attached in New task with the task itself, without an extra answer or a wait", async () => {
    const c = await create([path.join(dir, "card.indd"), path.join(dir, "contacts.csv")]);
    const ready = await until(c.id, (x) => x.status === "ready");
    expect(ready.status).toBe("ready");
    expect(kinds()).toEqual(["turn", "code"]);
    const task = text(calls[0].messages[1]);
    expect(task).toContain("Inside card.indd");
    expect(task).toContain("Name Surname");
    expect(task).toContain("columns: Name, email");
  });

  it("reads a template in a folder only by name, as New task promises", async () => {
    const folder = path.join(dir, "assets");
    await fs.mkdir(folder);
    await fs.rename(path.join(dir, "card.indd"), path.join(folder, "card.indd"));
    const c = await service.create({ request: "Make a business card per row", references: [path.join(dir, "contacts.csv")], folders: [folder], appId: "indesign", apps: [{ appId: "indesign", noDocument: true }] });
    await until(c.id, (x) => x.status === "ready");
    expect(read).not.toContain("card.indd");
    expect(text(calls[0].messages[1])).not.toContain("Name Surname");
  });

  it("goes on when a file can't be read", async () => {
    readFile = async () => {
      throw new Error("InDesign is busy");
    };
    const c = await create([path.join(dir, "card.indd"), path.join(dir, "contacts.csv")]);
    const ready = await until(c.id, (x) => x.status === "ready");
    expect(ready.status).toBe("ready");
    expect(kinds()).toEqual(["turn", "code"]);
  });

  it("sends no extra call for a file the AI has nothing more to see in", async () => {
    const attached = path.join(dir, "contacts.csv");
    const c = await service.create({ request: "Make a business card per row", references: [attached, path.join(dir, "card.indd")], appId: "indesign", apps: [{ appId: "indesign", noDocument: true }] });
    await until(c.id, (x) => x.status === "ready");
    // Told once: nothing new comes up at the proposal.
    expect(calls.filter((x) => x.kind === "turn")).toHaveLength(1);
    expect(read.filter((f) => f === "card.indd")).toHaveLength(1);
  });
});

const askForFiles = { action: "ask_for_files", reason: "Ask for the template and the data", routine: { inputs: routine.inputs } };

describe("the AI asks for files first", () => {
  it("asks before it plans anything, then plans with the files in view", async () => {
    turns = [askForFiles];
    const c = await create();
    const waiting = await until(c.id, (x) => x.status === "waiting" && x.needs?.kind === "samples");
    expect(waiting.needs).toMatchObject({ optional: true, inputs: [{ key: "template" }, { key: "contacts" }] });
    expect(waiting.needs!.message).toContain("before it plans anything");
    expect(kinds()).toEqual(["turn"]);

    await service.addSamples(c.id, { files: [path.join(dir, "card.indd"), path.join(dir, "contacts.csv")], folders: [] });
    await service.confirmSamples(c.id);
    const ready = await until(c.id, (x) => x.status === "ready");
    // No plan was written blind: the first plan comes with the files shown, and no third answer is needed.
    expect(kinds()).toEqual(["turn", "turn", "code"]);
    const told = text(calls[1].messages.at(-1)!);
    expect(told).toContain("Name Surname");
    expect(told).toContain("ada@example.com");
    expect(ready.aiCalls).toBe(3);
  });

  it("goes on without the files when the designer says so, and the AI knows", async () => {
    turns = [askForFiles, { action: "propose_routine", reason: "Cards", routine: { ...routine, inputs: [] } }];
    code = 'var d = app.documents.add();\nvar f = ctx.exportPdf(d, ctx.workDir + "/cards.pdf", {});\nctx.close(d);\nctx.output({ key: "pdf", label: "Print PDF", filePath: f.fsName });';
    const c = await create();
    await until(c.id, (x) => x.status === "waiting" && x.needs?.kind === "samples");
    await service.confirmSamples(c.id);
    const ready = await until(c.id, (x) => x.status === "ready");
    expect(ready.status).toBe("ready");
    expect(text(calls[1].messages.at(-1)!)).toContain("went on without these files");
    expect(kinds()).toEqual(["turn", "turn", "code"]);
  });

  it("still needs a sample to try a routine that names a file, even after going on without it", async () => {
    turns = [askForFiles];
    const c = await create();
    await until(c.id, (x) => x.status === "waiting" && x.needs?.kind === "samples");
    await service.confirmSamples(c.id);
    const waiting = await until(c.id, (x) => x.status === "waiting" && x.needs?.kind === "samples" && !x.needs.optional);
    expect(waiting.needs!.message).toContain("to try this routine");
    // Nothing added: this one can't be left out.
    await service.confirmSamples(c.id);
    expect(service.getCreation(c.id)!.status).toBe("waiting");
  });

  it("doesn't stop the designer when the files are already attached", async () => {
    turns = [askForFiles];
    const c = await create([path.join(dir, "card.indd"), path.join(dir, "contacts.csv")]);
    const ready = await until(c.id, (x) => x.status === "ready");
    expect(ready.status).toBe("ready");
    expect(text(calls[1].messages.at(-1)!)).toContain("Nothing more to show");
    expect(kinds()).toEqual(["turn", "turn", "code"]);
  });

  it("asks once", async () => {
    turns = [askForFiles, askForFiles];
    const c = await create();
    await until(c.id, (x) => x.status === "waiting" && x.needs?.kind === "samples");
    await service.addSamples(c.id, { files: [path.join(dir, "card.indd"), path.join(dir, "contacts.csv")], folders: [] });
    await service.confirmSamples(c.id);
    await until(c.id, (x) => x.status === "ready");
    expect(text(calls[2].messages.at(-1)!)).toContain("already asked for files");
  });

  it("asks for a file the AI adds in a later proposal before that code too", async () => {
    // The first proposal needs only the attached data; its trial fails, and the next one also names a template.
    let failed = false;
    review = () => {
      if (failed) return {};
      failed = true;
      return { missed: true };
    };
    turns = [
      { action: "propose_routine", reason: "Cards", routine: { ...routine, inputs: [routine.inputs[1]] } },
      { action: "propose_routine", reason: "Cards", routine },
    ];
    const c = await create([path.join(dir, "contacts.csv")]);
    const waiting = await until(c.id, (x) => x.status === "waiting" && x.needs?.kind === "samples");
    expect(waiting.needs!.inputs.map((i) => i.key)).toEqual(["template"]);
    expect(kinds()).toEqual(["turn", "code", "turn"]);
    await service.addSamples(c.id, { files: [path.join(dir, "card.indd")], folders: [] });
    await service.confirmSamples(c.id);
    await until(c.id, (x) => x.status === "ready");
    expect(kinds().slice(3)[0]).toBe("turn");
    expect(text(calls[3].messages.at(-1)!)).toContain("Name Surname");
  });
});
