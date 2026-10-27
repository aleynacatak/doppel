import { net } from "electron";

// Figma REST API (https://developers.figma.com/docs/rest-api/): reading files by link with a
// personal access token sent as X-Figma-Token. Scopes needed: file_content:read, current_user:read.

export const FIGMA_API = "https://api.figma.com/v1";

export class FigmaApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FigmaApiError";
  }
}

/** https://www.figma.com/design/<key>/<name>?node-id=1-2 (also /file/, /proto/, branches). */
export function parseFigmaLink(url: string): { key: string; nodeId?: string } | null {
  const m = url.trim().match(/figma\.com\/(?:file|design|proto|board|slides)\/([A-Za-z0-9]{10,})(?:\/[^/?#]*)?(?:\/branch\/([A-Za-z0-9]{10,}))?/);
  if (!m) return null;
  let nodeId: string | undefined;
  try {
    const raw = new URL(url.trim()).searchParams.get("node-id");
    nodeId = raw ? raw.replace("-", ":") : undefined;
  } catch {
    nodeId = undefined;
  }
  return { key: m[2] ?? m[1], nodeId };
}

export const fileLink = (key: string, nodeId?: string) =>
  `https://www.figma.com/design/${key}${nodeId ? `?node-id=${encodeURIComponent(nodeId.replace(":", "-"))}` : ""}`;

async function get<T>(path: string, token: string): Promise<T> {
  let res: Response;
  try {
    res = await net.fetch(`${FIGMA_API}${path}`, { headers: { "X-Figma-Token": token } });
  } catch {
    throw new FigmaApiError(0, "Doppel can't reach Figma. Check your internet connection and try again.");
  }
  if (res.ok) return (await res.json()) as T;
  switch (res.status) {
    case 401:
    case 403:
      throw new FigmaApiError(
        res.status,
        "Figma didn't accept the access token, or its account can't open this file. Check the token (with file_content:read and current_user:read) and that you can open the file in Figma.",
      );
    case 404:
      throw new FigmaApiError(404, "Figma couldn't find this file. Check the link.");
    case 429:
      throw new FigmaApiError(429, "Figma is limiting requests right now. Try again in a minute.");
    default:
      throw new FigmaApiError(res.status, `Figma's API returned an error (status ${res.status}). Try again in a moment.`);
  }
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
}

export interface FigmaFileResponse {
  name: string;
  lastModified: string;
  thumbnailUrl?: string;
  document: FigmaNode;
  styles?: Record<string, { name: string; styleType: string; description?: string }>;
}

export const getMe = (token: string) => get<{ id: string; handle: string; email?: string }>("/me", token);

export const getFile = (token: string, key: string, depth = 2) =>
  get<FigmaFileResponse>(`/files/${encodeURIComponent(key)}?depth=${depth}`, token);

/** Renders nodes to images; returns node id → bytes. */
export async function renderNodes(token: string, key: string, ids: string[], scale = 1): Promise<Record<string, Buffer>> {
  const data = await get<{ err?: string | null; images: Record<string, string | null> }>(
    `/images/${encodeURIComponent(key)}?ids=${encodeURIComponent(ids.join(","))}&format=png&scale=${scale}`,
    token,
  );
  const result: Record<string, Buffer> = {};
  for (const [id, url] of Object.entries(data.images ?? {})) {
    if (!url) continue;
    const res = await net.fetch(url);
    if (res.ok) result[id] = Buffer.from(await res.arrayBuffer());
  }
  return result;
}

const FRAME_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "SECTION", "INSTANCE"]);

/** Top-level frames on every page of a file (from getFile with depth 2). */
export function topFrames(file: FigmaFileResponse) {
  return (file.document.children ?? []).flatMap((page) =>
    (page.children ?? [])
      .filter((n) => FRAME_TYPES.has(n.type))
      .map((n) => ({
        id: n.id,
        name: n.name,
        page: page.name,
        width: Math.round(n.absoluteBoundingBox?.width ?? 0),
        height: Math.round(n.absoluteBoundingBox?.height ?? 0),
      })),
  );
}
