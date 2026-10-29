import type { AppStatusService } from "../services/appStatusService";
import type { AppId, ReadinessItem } from "../types";
import type { AdapterSource } from "./nodeRunner";

/** A routine node as readiness sees it: its app, and whether it works on an open document. */
export interface ReadinessUnit {
  appId: AppId;
  name: string;
  needsDocument: boolean;
}

function notReadyMessage(appId: AppId, appName: string, status: string, needsDocument: boolean) {
  if (status === "permission-denied") {
    return `Doppl isn't allowed to control ${appName}. Turn it on in System Settings → Privacy & Security → Automation.`;
  }
  if (status === "not-installed") return `${appName} isn't installed on this Mac.`;
  if (status === "awaiting-permission") return `macOS is asking whether Doppl may control ${appName}. Click OK in that prompt.`;
  if (appId === "figma") return "Open your file in Figma and start the Doppl plugin (Plugins → Development → Doppl).";
  return needsDocument ? `Open ${appName} with your document.` : `Open ${appName}.`;
}

/** Per app: connected, and (for routines that work on an open document) the right document open. */
export async function checkReadiness(
  adapters: AdapterSource & { list(): { id: AppId }[] },
  apps: Pick<AppStatusService, "statusOf">,
  units: ReadinessUnit[],
  picked: Partial<Record<AppId, string>> = {},
): Promise<ReadinessItem[]> {
  const byApp = new Map<AppId, ReadinessUnit[]>();
  for (const u of units) byApp.set(u.appId, [...(byApp.get(u.appId) ?? []), u]);
  const out: ReadinessItem[] = [];
  for (const [appId, list] of byApp) {
    const uses = [...new Set(list.map((u) => u.name))];
    if (!adapters.list().some((a) => a.id === appId)) {
      out.push({ appId, appName: appId, status: "not-installed", ok: false, message: `Doppl can't run routines in "${appId}".`, needsDocument: false, documents: [], uses });
      continue;
    }
    const adapter = adapters.get(appId);
    const status = await apps.statusOf(appId).catch(() => "not-running" as const);
    const needsDocument = list.some((u) => u.needsDocument);
    const documents = status === "connected" ? await adapter.listOpenDocuments().catch(() => []) : [];
    const documentId = documents.find((d) => d.id === picked[appId])?.id ?? (documents.find((d) => d.active) ?? documents[0])?.id;
    let ok = status === "connected";
    let message = ok ? undefined : notReadyMessage(appId, adapter.name, status, needsDocument);
    if (ok && needsDocument && !documentId) {
      ok = false;
      message = appId === "figma" ? "Start the Doppl plugin in the Figma file these routines work on." : `Open the document these routines work on in ${adapter.name}.`;
    }
    if (ok && needsDocument && picked[appId] && picked[appId] !== documentId) {
      ok = false;
      message = `The document picked for ${adapter.name} isn't open anymore. Pick another one.`;
    }
    out.push({ appId, appName: adapter.name, status, ok, message, needsDocument, documents, documentId: needsDocument ? documentId : undefined, uses });
  }
  return out;
}
