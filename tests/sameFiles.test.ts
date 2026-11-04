import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../electron/adapters/registry";
import { resolveInput } from "../electron/core/flows/values";
import type { DesignAppAdapter, StageItemInput, StageRunContext } from "../electron/adapters/types";
import type { AiAccessService } from "../electron/core/services/aiAccessService";
import type { AiService } from "../electron/core/services/aiService";
import type { AppStatusService } from "../electron/core/services/appStatusService";
import { FlowService, routineFlow } from "../electron/core/services/flowService";
import { LibraryService } from "../electron/core/services/libraryService";
import { QcService } from "../electron/core/services/qcService";
import { RunService } from "../electron/core/services/runService";
import { StarterService } from "../electron/core/services/starterService";
import { JsonStorage } from "../electron/core/services/storage";
import type { Routine, Run, RunRequest, RunTarget } from "../electron/core/types";
import { forNodes, sameFilesOfRun } from "../renderer/lib/sameFiles";
import { fakeImage } from "./helpers/images";

// "Run with same files": what an earlier run used, handed to a new one. The run screen sends these values as they are,
// and checks them first: a file that's gone or a document that's closed must stop the run, not fail it halfway.

const TARGET: RunTarget = { kind: "flow", id: "cards-flow" };

let dir: string;
let open: { id: string; name: string; active?: boolean }[];
let storage: JsonStorage;
let runs: RunService;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-same-"));
  await fs.mkdir(path.join(dir, "photos"));
  for (const f of ["fig.jpg", "plum.jpg"]) await fs.writeFile(path.join(dir, "photos", f), fakeImage(f));
  open = [
    { id: "doc-a", name: "A.psd", active: true },
    { id: "doc-b", name: "B.psd" },
  ];
  const photoshop = {
    id: "photoshop",
    name: "Adobe Photoshop",
    stageKind: "script",
    qcChecks: [],
    getStatus: async () => "connected",
    getAppVersion: async () => "27.0",
    listOpenDocuments: async () => open.map((d) => ({ ...d, appId: "photoshop" })),
    beginStage: async () => ({ state: {} }),
    endStage: async () => undefined,
    async runStageItem(_s: unknown, input: StageItemInput, ctx: StageRunContext) {
      await fs.mkdir(ctx.workDir, { recursive: true });
      const file = path.join(ctx.workDir, `${(input.item as { stem: string }).stem}.png`);
      await fs.writeFile(file, "png");
      return { ok: true, outputs: [{ key: `${input.key}-1`, label: path.basename(file), filePath: file }], values: { cards: [file] }, findings: [], log: [] };
    },
  } as unknown as DesignAppAdapter;
  const registry = new AdapterRegistry([photoshop]);
  storage = new JsonStorage(path.join(dir, "data"));
  const starters = new StarterService(path.join(dir, "starters"));
  await starters.load();
  const library = new LibraryService({ storage, starters });
  const flows = new FlowService({ storage, library, starters, registry });
  runs = new RunService({
    storage,
    library,
    flows,
    registry,
    apps: { statusOf: async () => "connected" } as unknown as AppStatusService,
    qc: new QcService({ reviewOutput: async () => ({ level: "visual", label: "AI visual review", passed: true }) } as unknown as AiService),
    access: { ensureReady: async () => undefined } as unknown as AiAccessService,
    emit: () => undefined,
    runsDir: path.join(dir, "runs"),
    copiesDir: path.join(dir, "copies"),
  });
  const now = new Date().toISOString();
  const routine = {
    id: "cards",
    name: "Photo cards",
    appId: "photoshop",
    description: "",
    steps: [{ plainLanguage: "Saves a card" }],
    inputs: [
      { key: "file", label: "Template", type: "document", required: true },
      { key: "photos", label: "Photos", type: "fileList", required: true, extensions: ["jpg"] },
    ],
    outputs: [{ key: "cards", label: "Cards", type: "fileList", required: true, extensions: ["png"] }],
    settings: [],
    iterate: { input: "photos" },
    kind: "script",
    script: "ctx.log(1);",
    version: 1,
    createdWithAiCalls: 1,
    appVersion: "27.0",
    requiredFonts: [],
    runs: [],
    createdAt: now,
    updatedAt: now,
    versions: [],
    modifiesDocument: false,
    qcProfile: "web",
    format: 2,
  } as unknown as Routine;
  await library.save(routine);
  await storage.saveFlow({ ...routineFlow(routine), id: TARGET.id, name: "Cards" });
});

const finished = async (id: string) => {
  for (let i = 0; i < 400 && (await storage.getRun(id))?.status === "running"; i++) await new Promise((r) => setTimeout(r, 5));
  return (await storage.getRun(id))!;
};

const firstRun = async () =>
  finished(
    (
      await runs.start(TARGET, {
        inputs: { "input-photos": path.join(dir, "photos") },
        outputFolders: { "output-cards": path.join(dir, "out") },
        qcMode: "auto",
        options: { target: "copy", documents: { photoshop: "doc-b" } },
      })
    ).id,
  );

/** What the run screen sends when nothing was changed on it. */
const request = (run: Run): RunRequest => {
  const same = sameFilesOfRun(run);
  return {
    inputs: same.inputs,
    outputFolders: same.outputFolders,
    settings: same.settings,
    matches: same.matches,
    columns: same.columns,
    qcMode: same.qcMode,
    options: { target: "copy", documents: same.documents, qcOptions: same.qcOptions },
  };
};

describe("running with the same files", () => {
  it("uses the earlier run's files, folders and document, even when another document is in front", async () => {
    const first = await firstRun();
    expect(first.status).toBe("succeeded");
    const again = await finished((await runs.start(TARGET, request(first))).id);
    expect(again.status).toBe("succeeded");
    expect(again.id).not.toBe(first.id);
    expect(again.inputs).toEqual(first.inputs);
    expect(again.outputFolders).toEqual(first.outputFolders);
    expect(again.options.documents).toEqual({ photoshop: "doc-b" });
  });

  it("doesn't overwrite what the earlier run saved", async () => {
    const first = await firstRun();
    await finished((await runs.start(TARGET, request(first))).id);
    expect(await fs.readdir(path.join(dir, "out"))).toHaveLength(4);
  });

  it("stops before running when that document isn't open anymore", async () => {
    const first = await firstRun();
    open = open.filter((d) => d.id !== "doc-b");
    const [readiness] = await runs.readiness(TARGET, sameFilesOfRun(first).documents);
    expect(readiness).toMatchObject({ ok: false, documentId: "doc-a" });
    expect(readiness.message).toContain("isn't open anymore");
    await expect(runs.start(TARGET, request(first))).rejects.toThrow("isn't open anymore");
  });

  it("reports a folder that's gone in the check before the run", async () => {
    const first = await firstRun();
    await fs.rm(path.join(dir, "photos"), { recursive: true });
    const report = await runs.preflight(TARGET, { inputs: sameFilesOfRun(first).inputs });
    expect(report.needs).toEqual([expect.objectContaining({ kind: "file", inputNodeId: "input-photos" })]);
  });

  it("skips a picked file that's gone and says why, in the check and in the run", async () => {
    const files = ["fig.jpg", "plum.jpg"].map((f) => path.join(dir, "photos", f));
    await fs.rm(files[1]);
    const report = await runs.preflight(TARGET, { inputs: { "input-photos": files } });
    expect(report.needs).toEqual([]);
    expect(report.skipped.map((s) => s.text)).toEqual(["plum.jpg isn't there anymore: it may have been moved or renamed. It will be skipped."]);
    const run = await finished(
      (await runs.start(TARGET, { inputs: { "input-photos": files }, outputFolders: { "output-cards": path.join(dir, "out") }, qcMode: "auto", options: { target: "copy", documents: { photoshop: "doc-b" } } })).id,
    );
    expect(run.status).toBe("partial");
    expect(run.outputs.find((o) => o.status === "failed")?.error).toContain("isn't there anymore");
    expect(await fs.readdir(path.join(dir, "out"))).toEqual(["fig.png"]);
  });

  it("stops at the check when every picked file is gone", async () => {
    const files = ["fig.jpg", "plum.jpg"].map((f) => path.join(dir, "photos", f));
    await fs.rm(path.join(dir, "photos"), { recursive: true });
    const report = await runs.preflight(TARGET, { inputs: { "input-photos": files } });
    expect(report.needs.map((n) => n.text)).toEqual(["Photos: none of the 2 picked files are there anymore. They may have been moved or renamed."]);
  });

  it("stops at the check when a single file or folder is gone, of any format", async () => {
    const gone = path.join(dir, "gone.txt");
    await expect(resolveInput({ key: "brief", label: "Brief", type: "file", required: true }, gone)).rejects.toThrow("gone.txt isn't there anymore");
    await expect(resolveInput({ key: "pics", label: "Pictures", type: "folder", required: true }, path.join(dir, "gone"))).rejects.toThrow("gone isn't there anymore");
    await expect(resolveInput({ key: "pics", label: "Pictures", type: "fileList", required: true }, [gone])).rejects.toThrow("gone.txt isn't there anymore");
  });

  it("leaves out values for nodes the flow doesn't have anymore", () => {
    expect(forNodes({ kept: "a", removed: "b" }, [{ id: "kept" }])).toEqual({ kept: "a" });
  });
});
