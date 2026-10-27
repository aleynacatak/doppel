import type { AdapterRegistry } from "../../adapters/registry";
import type { AppStatusService } from "../services/appStatusService";
import type { AppId, ReadinessItem, Stage } from "../types";

/** Older single-app routines run as one script stage. */
export function stagesOf(routine: { stages?: Stage[]; appId: AppId; name: string; script: string; modifiesDocument?: boolean }): Stage[] {
  if (routine.stages?.length) return routine.stages;
  return [
    {
      id: "main",
      name: routine.name,
      appId: routine.appId,
      kind: "script",
      body: routine.script,
      inputs: [],
      outputs: [],
      document: "open",
      modifiesDocument: routine.modifiesDocument,
    },
  ];
}

function notReadyMessage(appId: AppId, appName: string, status: string, needsDocument: boolean) {
  if (status === "permission-denied") {
    return `Doppl isn't allowed to control ${appName}. Turn it on in System Settings → Privacy & Security → Automation.`;
  }
  if (status === "not-installed") return `${appName} isn't installed on this Mac.`;
  if (appId === "figma") return "Open your file in Figma and start the Doppl plugin (Plugins → Development → Doppl).";
  return needsDocument ? `Open ${appName} with your document.` : `Open ${appName}.`;
}

/** Per app: connected, and (for stages that work on an open document) the right document open. */
export async function checkReadiness(
  registry: AdapterRegistry,
  apps: AppStatusService,
  stages: Stage[],
  picked: Partial<Record<AppId, string>> = {},
): Promise<ReadinessItem[]> {
  const byApp = new Map<AppId, Stage[]>();
  for (const s of stages) byApp.set(s.appId, [...(byApp.get(s.appId) ?? []), s]);
  const out: ReadinessItem[] = [];
  for (const [appId, list] of byApp) {
    let adapter;
    try {
      adapter = registry.get(appId);
    } catch {
      out.push({ appId, appName: appId, status: "not-installed", ok: false, message: `Doppl can't run stages in "${appId}".`, needsDocument: false, documents: [], stages: list.map((s) => s.name) });
      continue;
    }
    const status = await apps.statusOf(appId).catch(() => "not-running" as const);
    const needsDocument = list.some((s) => (s.document ?? "open") === "open");
    const documents = status === "connected" ? await adapter.listOpenDocuments().catch(() => []) : [];
    const documentId = documents.find((d) => d.id === picked[appId])?.id ?? (documents.find((d) => d.active) ?? documents[0])?.id;
    let ok = status === "connected";
    let message = ok ? undefined : notReadyMessage(appId, adapter.name, status, needsDocument);
    if (ok && needsDocument && !documentId) {
      ok = false;
      message = appId === "figma" ? "Start the Doppl plugin in the Figma file this routine works on." : `Open the document this routine works on in ${adapter.name}.`;
    }
    if (ok && needsDocument && picked[appId] && picked[appId] !== documentId) {
      ok = false;
      message = `The document picked for ${adapter.name} isn't open anymore. Pick another one.`;
    }
    out.push({ appId, appName: adapter.name, status, ok, message, needsDocument, documents, documentId: needsDocument ? documentId : undefined, stages: list.map((s) => s.name) });
  }
  return out;
}
