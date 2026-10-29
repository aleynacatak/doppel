import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterRegistry } from "../../adapters/registry";
import type { AdapterOutput, DesignAppAdapter, StageItemInput, StageRunContext } from "../../adapters/types";
import type { AppId, PreviewImage } from "../types";
import type { AdapterSource } from "./nodeRunner";

// Simulated apps for the dev panel ("Run a flow with all adapters mocked"): every routine "runs" instantly, writes
// a small placeholder file for each file output and passes data rows along, so a flow's handoffs, joins, partial
// failures and cancel can be tried without InDesign, Photoshop or Figma. No app is touched and no AI is used.

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAIklEQVR42mNkYGD4z0AEYBxVSF+FjP///ycmgFEFowqoqQAA6lYI4UH5xsMAAAAASUVORK5CYII=",
  "base64",
);

function preview(label: string, app: string): PreviewImage {
  const text = label.replace(/[<&>"]/g, " ").slice(0, 40);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#ededed"/><text x="160" y="92" font-family="sans-serif" font-size="14" text-anchor="middle" fill="#676767">Simulated ${app}</text><text x="160" y="116" font-family="sans-serif" font-size="13" text-anchor="middle" fill="#1a1a1a">${text}</text></svg>`;
  return { kind: "image", src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width: 320, height: 200, label };
}

const safe = (s: string) => s.replace(/[/\\:*?"<>|·]/g, "-").replace(/\s+/g, " ").trim().slice(0, 60) || "item";

async function freePath(dir: string, stem: string, ext: string) {
  for (let n = 1; ; n++) {
    const file = path.join(dir, `${stem}${n === 1 ? "" : `-${n}`}.${ext}`);
    try {
      await fs.access(file);
    } catch {
      return file;
    }
  }
}

function simulate(real: DesignAppAdapter, delayMs: number): DesignAppAdapter {
  const short = real.name.replace(/^Adobe /, "");
  const unsupported = async (): Promise<never> => {
    throw new Error(`Simulated ${short} can't do that.`);
  };
  return {
    id: real.id,
    name: real.name,
    scriptLanguage: real.scriptLanguage,
    connection: real.connection,
    modelGuide: real.modelGuide,
    qcChecks: real.qcChecks,
    stageKind: real.stageKind,
    getStatus: async () => "connected",
    getDetail: async () => "Simulated",
    getAppVersion: async () => null,
    listOpenDocuments: async () => [{ id: `simulated:${real.id}`, appId: real.id, name: `Simulated ${short} document`, active: true }],
    inspectDocument: unsupported,
    runScript: unsupported,
    renderPreview: unsupported,
    renderPagePreviews: async () => ({}),
    ruleChecks: async () => [],
    getParamOptions: async () => [],
    missingFonts: async () => [],
    openInApp: async () => undefined,
    closeDocument: async () => undefined,
    connect: async () => "connected",
    capabilityManifest: () => "",
    inspectForModel: unsupported,
    beginStage: async (ctx: StageRunContext) => ({ state: {}, documentName: `${ctx.routineName} (simulated)` }),
    runStageItem: async (_session, input: StageItemInput, ctx: StageRunContext) => {
      await new Promise((r) => setTimeout(r, delayMs));
      await fs.mkdir(ctx.workDir, { recursive: true });
      const values: Record<string, unknown[]> = {};
      const outputs: AdapterOutput[] = [];
      for (const o of ctx.stage.outputs) {
        if (o.type === "file" || o.type === "fileList") {
          const ext = o.extensions?.[0] ?? "png";
          const file = await freePath(ctx.workDir, safe(input.label).replace(/\.[a-z0-9]{1,5}$/i, ""), ext);
          await fs.writeFile(file, ext === "png" ? TINY_PNG : `Simulated ${o.label ?? o.key} for ${input.label}\n`);
          values[o.key] = [file];
          outputs.push({ key: `${input.key}-${o.key}`, label: path.basename(file), filePath: file, preview: preview(path.basename(file), short), profile: "web" });
        } else {
          const base = input.item && typeof input.item === "object" && !Array.isArray(input.item) ? (input.item as Record<string, unknown>) : { item: input.label };
          values[o.key] = [{ ...base, [o.key]: `simulated ${o.key}` }];
        }
      }
      if (outputs.length === 0) outputs.push({ key: `${input.key}-result`, label: input.label, preview: preview(input.label, short) });
      return { ok: true, outputs, values, findings: [], log: [`Simulated ${short}`], data: { simulated: true, matched: input.matched ?? {} } };
    },
    endStage: async () => undefined,
    endRun: async () => undefined,
  };
}

/** Every app of the registry, simulated. */
export function simulatedApps(real: AdapterRegistry, delayMs = 150): AdapterSource & { list(): DesignAppAdapter[] } {
  const apps = real.list().map((a) => simulate(a, delayMs));
  return {
    list: () => apps,
    get: (id: AppId) => {
      const a = apps.find((x) => x.id === id);
      if (!a) throw new Error(`No adapter for app "${id}"`);
      return a;
    },
  };
}
