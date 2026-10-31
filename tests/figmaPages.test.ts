import { describe, expect, it } from "vitest";
import { FigmaAdapter } from "../electron/adapters/figma/figmaAdapter";
import type { FigmaPluginBridge } from "../electron/adapters/figma/pluginBridge";
import type { StageRunContext } from "../electron/adapters/types";
import { stageFor } from "../electron/core/flows/nodeRunner";
import type { Routine } from "../electron/core/types";

// A Figma run starts from the page its routine was made on, whatever page is open, and goes back to the designer's
// page when it's over. A copy no item worked on is removed, so failed runs leave nothing in the file.

const page = { id: "1:2", name: "jam-a-dox" };

/** The adapter with the plugin replaced: every request is recorded, items answer `ok`. */
function adapter(ok: boolean) {
  const sent: Record<string, unknown>[] = [];
  const bridge = {
    list: () => [{ id: "s1", documentId: "figma:key", fileName: "Playground", pageName: "Page 10" }],
    request: (_session: string, payload: Record<string, unknown>) => {
      sent.push(payload);
      const answers: Record<string, unknown> = {
        beginStage: { stageSessionId: "st", pageId: "9:9", pageName: "jam-a-dox (Doppl copy)", source: page },
        runItem: ok
          ? { ok: true, created: [], touched: [], outputs: {}, exports: [], findings: [], log: [], steps: [], shown: [], page: { id: "9:9", name: "copy" } }
          : { ok: false, error: { index: 0, action: "duplicateNode", message: 'No layer named "template" on page "jam-a-dox (Doppl copy)"' }, created: [], touched: [], outputs: {}, exports: [], findings: [], log: [], steps: [], shown: [], page: { id: "9:9", name: "copy" } },
      };
      return { id: String(sent.length), done: Promise.resolve(answers[String(payload.type)] ?? {}) };
    },
    cancel: () => undefined,
  } as unknown as FigmaPluginBridge;
  return { a: new FigmaAdapter({ getToken: async () => null, getFiles: () => [], bridge, getTimeoutSec: () => 30 }), sent };
}

const routine = { id: "r", name: "Labels", appId: "figma", kind: "actions", actions: [], inputs: [{ key: "doc", label: "Document", type: "document", required: true }], outputs: [], settings: [], modifiesDocument: true, figmaPage: page } as unknown as Routine;
const ctx = (target: StageRunContext["target"]): StageRunContext => ({
  runId: `run-${target}`,
  routineName: "Labels",
  stage: stageFor(routine, "n1", "Labels"),
  documentId: "figma:key",
  target,
  workDir: "/nowhere",
  copiesDir: "/nowhere",
  isCancelled: () => false,
});
const item = { key: "row-1", label: "Row 1", index: 0, item: {}, params: {}, body: { actions: [] } };

async function run(ok: boolean, target: StageRunContext["target"] = "copy") {
  const { a, sent } = adapter(ok);
  const c = ctx(target);
  const session = await a.beginStage(c);
  const res = await a.runStageItem(session, item, c, () => undefined);
  await a.endStage(session);
  await a.endRun(c.runId);
  return { sent, res };
}

describe("Figma runs and the designer's pages", () => {
  it("starts from the routine's page and keeps the page with the item's data", async () => {
    const { sent, res } = await run(true);
    expect(sent[0]).toMatchObject({ type: "beginStage", mode: "copy", source: page });
    expect((res.data as { source?: unknown }).source).toEqual(page);
  });

  it("keeps a copy with results, and removes one no item worked on", async () => {
    expect((await run(true)).sent.at(-1)).toEqual({ type: "finishPage", pageId: "9:9", remove: false });
    const failed = await run(false);
    expect(failed.sent.at(-1)).toEqual({ type: "finishPage", pageId: "9:9", remove: true });
    expect(failed.res.ok).toBe(false);
  });

  it("removes a trial's scratch page even when it worked", async () => {
    expect((await run(true, "trial")).sent.at(-1)).toEqual({ type: "finishPage", pageId: "9:9", remove: true });
  });
});
