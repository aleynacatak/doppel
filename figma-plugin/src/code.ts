import { parseWireActions } from "../../electron/shared/figmaActions";
import { type ActionRunResult, CancelledInFigma, checkNode, type Finding, Interpreter, mapIds, summary } from "./interpreter";

// Doppl plugin for Figma (sandbox side). The window (ui.ts) holds the connection to the Doppl app; this side
// runs requests: stages of action lists, inspections, previews. Action lists are validated again here with the
// same schemas Doppl uses, then run by the interpreter. No code strings are ever executed.

const PLUGIN_VERSION = "2.1.0";
const PREVIEW_WIDTH = 640;
const MAX_PREVIEWS = 4;

figma.showUI(__html__, { width: 300, height: 210, title: "Doppl", themeColors: true });

/** A page stages work on: the routine's page, a copy, or a scratch copy (trial). Later stages of a run reuse it. */
interface PageState {
  page: PageNode;
  /** The designer's page the run started from. */
  original: PageNode;
  /** The page Figma showed before the run, shown again when it's over. */
  shown: PageNode;
  mode: "copy" | "original" | "trial";
  idMap?: Map<string, string>;
  /** What the designer had selected on the original page. */
  selection: string[];
  createdPages: PageNode[];
}

const pages = new Map<string, PageState>();
const stages = new Map<string, string>(); // stage session id → page id
let current: { id: string; cancelled: boolean } | null = null;

function info() {
  let fileKey: string | undefined;
  try {
    fileKey = figma.fileKey;
  } catch {
    fileKey = undefined;
  }
  return { fileName: figma.root.name, fileKey, pageName: figma.currentPage.name, pluginVersion: PLUGIN_VERSION };
}

const post = (msg: Record<string, unknown>) => figma.ui.postMessage(msg);

figma.on("currentpagechange", () => post({ type: "info", info: info() }));

figma.ui.onmessage = async (msg: { type: string; id?: string; payload?: Record<string, unknown>; code?: string }) => {
  if (msg.type === "ready") {
    const code = ((await figma.clientStorage.getAsync("pairingCode")) as string | undefined) ?? "";
    post({ type: "init", info: info(), code });
  } else if (msg.type === "saveCode") {
    await figma.clientStorage.setAsync("pairingCode", msg.code ?? "");
  } else if (msg.type === "cancel") {
    // From Doppl (a request id) or from the Cancel button (no id).
    if (current && (!msg.id || msg.id === current.id)) current.cancelled = true;
  } else if (msg.type === "request" && msg.id && msg.payload) {
    const id = msg.id;
    const mine = { id, cancelled: false };
    current = mine;
    try {
      const result = await handle(msg.payload, mine, id);
      post({ type: "response", id, ok: true, result });
    } catch (err) {
      const cancelled = err instanceof CancelledInFigma;
      post({ type: "response", id, ok: false, cancelled, error: (err as Error)?.message ?? String(err) });
    } finally {
      if (current === mine) current = null;
      post({ type: "activity", text: "" });
    }
  }
};

async function handle(p: Record<string, unknown>, req: { cancelled: boolean }, requestId: string): Promise<unknown> {
  switch (p.type) {
    case "info":
      return info();
    case "beginStage":
      return beginStage(String(p.mode) as PageState["mode"], String(p.routineName ?? "routine"), p.reusePageId as string | undefined, p.source as PageRef | undefined);
    case "runItem":
      return runItem(String(p.stageSessionId), p.actions, String(p.label ?? ""), req, requestId);
    case "endStage":
      stages.delete(String(p.stageSessionId));
      return { ended: true };
    case "finishPage":
      return finishPage(String(p.pageId), p.remove === true);
    case "inspect":
      return inspect(p.node as string | undefined, Number(p.depth ?? 2));
    case "preview":
      return previews((p.nodeIds as string[]) ?? [], Number(p.width ?? PREVIEW_WIDTH));
    case "focus":
      return focus(String(p.nodeId));
    case "fonts":
      return fontFamilies();
    default:
      throw new Error(`Unknown request: ${String(p.type)}`);
  }
}

// ---------- Stages ----------

type PageRef = { id?: string; name?: string };
/** " (Doppl copy)" at the end of a page name; older versions wrote "Doppel". */
const COPY = / \(Dopp(?:l|el) copy\)$/;

/**
 * The page a run starts from: the routine's own page while the file has it, whatever page is open. Otherwise the open
 * page, but never a Doppl copy: a copy holds an earlier run's results, so the page it was copied from is used.
 */
function startPage(source?: PageRef): PageNode {
  const all = figma.root.children;
  const byId = source?.id ? all.find((p) => p.id === source.id) : undefined;
  if (byId) return byId;
  const named = source?.name ? all.filter((p) => p.name === source.name) : [];
  if (named.length === 1) return named[0];
  let name = figma.currentPage.name;
  while (COPY.test(name)) {
    name = name.replace(COPY, "");
    const from = all.filter((p) => p.name === name);
    if (from.length === 1) return from[0];
  }
  return figma.currentPage;
}

async function beginStage(mode: PageState["mode"], routineName: string, reusePageId?: string, source?: PageRef) {
  let ps = reusePageId ? pages.get(reusePageId) : undefined;
  if (!ps || ps.page.removed) {
    const shown = figma.currentPage;
    const original = startPage(source);
    await original.loadAsync();
    const selection = original.selection.map((n) => n.id);
    let page = original;
    let idMap: Map<string, string> | undefined;
    if (mode !== "original") {
      page = original.clone();
      page.name = mode === "trial" ? `Doppl trial · ${routineName}` : `${original.name} (Doppl copy)`;
      idMap = mapIds(original, page);
    }
    ps = { page, original, shown, mode, idMap, selection, createdPages: [] };
    pages.set(page.id, ps);
  }
  await ps.page.loadAsync();
  if (ps.page !== figma.currentPage) await figma.setCurrentPageAsync(ps.page);
  const stageSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  stages.set(stageSessionId, ps.page.id);
  return { stageSessionId, pageId: ps.page.id, pageName: ps.page.name, source: { id: ps.original.id, name: ps.original.name } };
}

/**
 * A run is over: Figma shows the page the designer had open again, and the run's copy (with pages its actions made)
 * is removed when it's a trial's or Doppl says it kept nothing. The designer's own page is never removed.
 */
async function finishPage(pageId: string, remove: boolean) {
  const ps = pages.get(pageId);
  if (!ps) return { removed: false };
  pages.delete(pageId);
  if (figma.currentPage === ps.page || ps.createdPages.includes(figma.currentPage)) await figma.setCurrentPageAsync(ps.shown.removed ? ps.original : ps.shown);
  if (ps.page === ps.original || !(remove || ps.mode === "trial")) return { removed: false };
  for (const p of ps.createdPages) if (!p.removed) p.remove();
  if (!ps.page.removed) ps.page.remove();
  return { removed: true };
}

async function runItem(stageSessionId: string, actions: unknown, label: string, req: { cancelled: boolean }, requestId: string) {
  const st = pages.get(stages.get(stageSessionId) ?? "");
  if (!st || st.page.removed) throw new Error("This stage isn't running in Figma anymore. Run the routine again.");
  const parsed = parseWireActions({ actions });
  if (!parsed.ok) {
    throw new Error(`The actions don't match the catalog: ${parsed.issues.slice(0, 5).map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  }
  figma.commitUndo();
  const result: ActionRunResult = await new Interpreter({
    figma,
    page: st.page,
    idMap: st.idMap,
    selection: st.selection,
    createdPages: st.createdPages,
    isCancelled: () => req.cancelled,
    progress: (text) => {
      post({ type: "activity", text: label ? `${text} · ${label}` : text });
      post({ type: "progress", id: requestId, text });
    },
  }).runAll(parsed.actions);
  figma.commitUndo();

  // Previews and frame checks: what the actions created, else the top-level frames they changed.
  const candidates = (result.created.length ? result.created : result.touched).slice(0, MAX_PREVIEWS);
  const shown: { nodeId: string; name: string; preview?: string }[] = [];
  const findings: Finding[] = [...result.findings];
  for (const id of candidates) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.type === "PAGE" || node.type === "DOCUMENT" || node.removed) continue;
    const scene = node as SceneNode;
    shown.push({ nodeId: id, name: scene.name, preview: await previewOf(scene, PREVIEW_WIDTH).catch(() => undefined) });
    for (const f of await checkNode(figma, scene)) if (!findings.some((x) => x.message === f.message)) findings.push(f);
  }
  return { ...result, findings, shown, page: { id: st.page.id, name: st.page.name } };
}

// ---------- Other requests ----------

async function previewOf(node: SceneNode, width: number): Promise<string> {
  const w = Math.max(1, Math.min(width, Math.round(node.width || width)));
  const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "WIDTH", value: w } });
  return figma.base64Encode(bytes);
}

async function previews(nodeIds: string[], width: number) {
  const out: Record<string, string> = {};
  for (const id of nodeIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (node && "exportAsync" in node) out[id] = await previewOf(node as SceneNode, width);
  }
  return out;
}

async function inspect(ref: string | undefined, depth: number) {
  const page = figma.currentPage;
  await page.loadAsync();
  const interpreter = new Interpreter({ figma, page, createdPages: [], isCancelled: () => false, progress: () => undefined });
  if (!ref) {
    return {
      file: info(),
      pages: figma.root.children.map((p) => ({ id: p.id, name: p.name, current: p === page })),
      // What the designer selected is usually the template: describe it in full.
      selection: page.selection.slice(0, 3).map((n) => interpreter.describe(n, 5)),
      page: interpreter.describe(page, Math.min(depth, 3)),
    };
  }
  return interpreter.describe(await interpreter.one(ref), Math.min(depth, 6));
}

async function focus(nodeId: string) {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("That layer isn't in this file anymore.");
  let page: BaseNode | null = node;
  while (page && page.type !== "PAGE") page = page.parent;
  if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page as PageNode);
  if (node.type !== "PAGE" && node.type !== "DOCUMENT") {
    figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
    figma.currentPage.selection = [node as SceneNode];
  }
  return true;
}

async function fontFamilies() {
  const fonts = await figma.listAvailableFontsAsync();
  return [...new Set(fonts.map((f) => f.fontName.family))];
}
