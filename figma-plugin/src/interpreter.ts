import type { WireActionT } from "../../electron/shared/figmaActions";

// Runs a validated action list (electron/shared/figmaActions.ts, "wire" form) against the Figma Plugin API.
// Nothing here evaluates code: every action is a fixed function. The Figma API comes in through `host`, so the
// interpreter can be tested with a fake one (tests/figmaInterpreter.test.ts).

export interface Finding {
  type: "font-missing" | "font-style-missing" | "text-overflow" | "outside-boundary" | "cut-off" | "upscaled-image" | "file-missing";
  message: string;
  nodeId?: string;
}

export interface ExportedFile {
  fileName: string;
  format: string;
  folder?: string;
  nodeId: string;
  /** base64 */
  data: string;
  /** Stage output key the file path goes to. */
  output?: string;
}

export interface ActionRunResult {
  ok: boolean;
  error?: { index: number; action: string; message: string };
  /** Summaries of named results ($id), as JSON. */
  results: Record<string, unknown>;
  /** Stage output key → values (exported files are added by Doppl once written). */
  outputs: Record<string, unknown[]>;
  exports: ExportedFile[];
  findings: Finding[];
  log: string[];
  /** Nodes the actions created (copies, placed SVGs, pages). */
  created: string[];
  /** Top-level frames the actions changed. */
  touched: string[];
  /** One summary per action that ran, in order (what the model and the dev panel see). */
  steps: { action: string; id?: string; result: unknown }[];
}

export interface Host {
  figma: PluginAPI;
  /** The page the stage works on (the current page, a copy, or a scratch copy). */
  page: PageNode;
  /** Original node id → id on the copied page (copy and scratch runs). */
  idMap?: Map<string, string>;
  /** Ids the designer had selected when the stage began. */
  selection?: string[];
  /** Pages created by createPage (removed again after scratch runs). */
  createdPages: PageNode[];
  isCancelled(): boolean;
  progress(text: string): void;
}

export class ActionError extends Error {}
export class CancelledInFigma extends Error {
  constructor() {
    super("Cancelled in Figma.");
  }
}

const ID_RE = /^I?\d+:\d+(;\d+:\d+)*$/;
const round = (n: number) => Math.round(n * 100) / 100;

type AnyNode = BaseNode & Partial<SceneNode>;

function hasChildren(n: BaseNode): n is BaseNode & ChildrenMixin {
  return "children" in n;
}

export function summary(n: BaseNode): Record<string, unknown> {
  const s: Record<string, unknown> = { id: n.id, name: n.name, type: n.type };
  const g = n as AnyNode;
  if (typeof g.x === "number") Object.assign(s, { x: round(g.x), y: round(g.y!), width: round(g.width!), height: round(g.height!) });
  return s;
}

function hex(c: RGB, opacity = 1) {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${opacity < 1 ? h(opacity) : ""}`.toUpperCase();
}

export function parseColor(value: string): { color: RGB; opacity: number } {
  let v = value.replace(/^#/, "");
  if (v.length === 3) v = v.split("").map((c) => c + c).join("");
  const n = (i: number) => parseInt(v.slice(i, i + 2), 16) / 255;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) throw new ActionError(`"${value}" isn't a hex color`);
  return { color: { r: n(0), g: n(2), b: n(4) }, opacity: v.length === 8 ? n(6) : 1 };
}

function format(pattern: string, item: Record<string, unknown>) {
  return pattern.replace(/\{([^{}]+)\}/g, (all, key: string) => (key in item ? String(item[key] ?? "") : all));
}

/** The ancestor whose parent is a page (or the node itself). */
function topLevel(n: BaseNode): BaseNode {
  let cur: BaseNode = n;
  while (cur.parent && cur.parent.type !== "PAGE" && cur.parent.type !== "DOCUMENT") cur = cur.parent;
  return cur;
}

function boxOf(n: BaseNode): Rect | null {
  const box = (n as AnyNode).absoluteBoundingBox;
  return box ?? null;
}

function edgeOutside(b: Rect, box: Rect, t = 0.5): string | null {
  if (b.x + b.width > box.x + box.width + t) return "right";
  if (b.x < box.x - t) return "left";
  if (b.y + b.height > box.y + box.height + t) return "bottom";
  if (b.y < box.y - t) return "top";
  return null;
}

export class Interpreter {
  private named = new Map<string, BaseNode[]>();
  private result: ActionRunResult = { ok: true, results: {}, outputs: {}, exports: [], findings: [], log: [], created: [], touched: [], steps: [] };

  constructor(private readonly host: Host) {}

  // ---------- Node references ----------

  private async byId(id: string): Promise<BaseNode> {
    const mapped = this.host.idMap?.get(id) ?? id;
    const node = await this.host.figma.getNodeByIdAsync(mapped);
    if (!node) throw new ActionError(`No node with id ${id}`);
    return node;
  }

  private findByName(root: BaseNode, name: string): BaseNode | null {
    if (!hasChildren(root)) return null;
    const direct = root.children.find((c) => c.name === name);
    if (direct) return direct;
    return (root as ChildrenMixin).findOne((c) => c.name === name);
  }

  private walkPath(root: BaseNode, segments: string[]): BaseNode | null {
    let cur: BaseNode | null = root;
    for (const [i, seg] of segments.entries()) {
      if (!cur || !hasChildren(cur)) return null;
      const children: readonly BaseNode[] = cur.children;
      cur = children.find((c) => c.name === seg) ?? (i === 0 ? this.findByName(cur, seg) : null);
    }
    return cur;
  }

  private async lookup(ref: string, scope?: BaseNode): Promise<BaseNode[]> {
    const r = ref.trim();
    if (r.startsWith("$")) {
      const m = r.match(/^\$([A-Za-z][A-Za-z0-9_]*)([\s\S]*)$/);
      if (!m) throw new ActionError(`"${ref}" isn't a valid reference`);
      const base = this.named.get(m[1]);
      if (!base) throw new ActionError(`"$${m[1]}" isn't the result of an earlier action`);
      const rest = m[2];
      if (!rest) return base;
      const out: BaseNode[] = [];
      for (const node of base) {
        let found: BaseNode | null = node;
        if (rest.startsWith(".#")) {
          for (const name of rest.slice(2).split(".#")) found = found ? (found.name === name && found === node ? found : this.findByName(found, name)) : null;
        } else if (rest.startsWith("/")) {
          found = this.walkPath(node, rest.slice(1).split("/"));
        } else {
          throw new ActionError(`"${ref}": use "$id.#name" or "$id/path"`);
        }
        if (!found) throw new ActionError(`Nothing named "${rest.replace(/^\.#|^\//, "").replace(/\.#/g, " › ")}" inside "${node.name}"`);
        out.push(found);
      }
      return out;
    }
    if (r.startsWith("page:")) {
      const [pageName, ...path] = r.slice(5).split("/");
      const page = this.host.figma.root.children.find((p) => p.name === pageName);
      if (!page) throw new ActionError(`No page named "${pageName}"`);
      await page.loadAsync();
      if (path.length === 0) return [page];
      const found = this.walkPath(page, path);
      if (!found) throw new ActionError(`No layer "${path.join("/")}" on page "${pageName}"`);
      return [found];
    }
    if (ID_RE.test(r)) return [await this.byId(r)];
    const root = scope ?? this.host.page;
    const exact = this.findByName(root, r);
    if (exact) return [exact];
    if (r.includes("/")) {
      const viaPath = this.walkPath(root, r.split("/"));
      if (viaPath) return [viaPath];
    }
    throw new ActionError(`No layer named "${r}" ${root.type === "PAGE" ? `on page "${root.name}"` : `inside "${root.name}"`}`);
  }

  async one(ref: string, scope?: BaseNode): Promise<BaseNode> {
    const nodes = await this.lookup(ref, scope);
    if (nodes.length !== 1) throw new ActionError(`"${ref}" is ${nodes.length} nodes here; this action needs one`);
    return nodes[0];
  }

  async many(ref: string | string[]): Promise<BaseNode[]> {
    const list = Array.isArray(ref) ? ref : [ref];
    const out: BaseNode[] = [];
    for (const r of list) out.push(...(await this.lookup(r)));
    return out;
  }

  // ---------- Helpers ----------

  private touch(n: BaseNode) {
    const top = topLevel(n);
    if (!this.result.touched.includes(top.id)) this.result.touched.push(top.id);
  }

  private scene(n: BaseNode, action: string): SceneNode {
    if (n.type === "PAGE" || n.type === "DOCUMENT") throw new ActionError(`${action} can't be used on a page`);
    return n as SceneNode;
  }

  /** Loads every font used in a text node. Missing fonts are reported (finding) and return false. */
  private async loadFonts(node: TextNode): Promise<boolean> {
    if (node.hasMissingFont) {
      this.result.findings.push({ type: "font-missing", message: `"${node.name}" uses a font that isn't available on this computer`, nodeId: node.id });
      return false;
    }
    const fonts = node.characters.length > 0 ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName as FontName];
    for (const font of fonts) {
      try {
        await this.host.figma.loadFontAsync(font);
      } catch {
        this.result.findings.push({ type: "font-missing", message: `Font "${font.family} ${font.style}" in "${node.name}" isn't available`, nodeId: node.id });
        return false;
      }
    }
    return true;
  }

  private text(n: BaseNode, action: string): TextNode {
    if (n.type !== "TEXT") throw new ActionError(`${action}: "${n.name}" isn't a text layer`);
    return n as TextNode;
  }

  private async setCharacters(node: TextNode, value: string, action: string) {
    if (!(await this.loadFonts(node))) {
      this.result.log.push(`${action}: kept the text of "${node.name}" because a font is missing`);
      return;
    }
    node.characters = value;
    this.touch(node);
  }

  /** Structure of a node for the model and the dev panel (see inspectNode). */
  describe(n: BaseNode, depth: number): Record<string, unknown> {
    return this.inspect(n, depth);
  }

  private inspect(n: BaseNode, depth: number): Record<string, unknown> {
    const s = summary(n);
    const g = n as AnyNode;
    if (g.visible === false) s.visible = false;
    if (n.type === "TEXT") {
      const t = n as TextNode;
      s.text = t.characters.slice(0, 500);
      if (t.characters.length) s.fonts = [...new Set(t.getRangeAllFontNames(0, t.characters.length).map((f) => `${f.family} ${f.style}`))];
      s.fontSize = t.fontSize === this.host.figma.mixed ? "mixed" : t.fontSize;
      s.textAutoResize = t.textAutoResize;
      if (t.hasMissingFont) s.missingFont = true;
    }
    const frame = n as FrameNode;
    if ("layoutMode" in n && frame.layoutMode !== "NONE") {
      s.autoLayout = {
        mode: frame.layoutMode,
        padding: [frame.paddingTop, frame.paddingRight, frame.paddingBottom, frame.paddingLeft],
        itemSpacing: frame.itemSpacing,
      };
    }
    if ("clipsContent" in n && frame.clipsContent) s.clipsContent = true;
    if ("fills" in n && Array.isArray(frame.fills)) {
      const fills = (frame.fills as Paint[]).filter((p) => p.visible !== false).map((p) => (p.type === "SOLID" ? hex(p.color, p.opacity ?? 1) : p.type));
      if (fills.length) s.fills = fills;
    }
    if (hasChildren(n)) {
      s.childCount = n.children.length;
      if (depth > 0) s.children = n.children.slice(0, 60).map((c) => this.inspect(c, depth - 1));
    }
    return s;
  }

  private record(action: WireActionT, nodes: BaseNode[] | null, value: unknown) {
    if (action.id && nodes) this.named.set(action.id, nodes);
    if (action.id) this.result.results[action.id] = value;
    if (action.output) {
      const list = (this.result.outputs[action.output] ??= []);
      if (Array.isArray(value)) list.push(...value);
      else list.push(value);
    }
    this.result.steps.push({ action: action.action, id: action.id, result: value });
  }

  // ---------- Actions ----------

  private async run(a: WireActionT): Promise<void> {
    const figma = this.host.figma;
    switch (a.action) {
      case "getSelection": {
        const ids = this.host.selection ?? figma.currentPage.selection.map((n) => n.id);
        const nodes: BaseNode[] = [];
        for (const id of ids) {
          const node = await figma.getNodeByIdAsync(this.host.idMap?.get(id) ?? id);
          if (node) nodes.push(node);
        }
        return this.record(a, nodes, nodes.map(summary));
      }
      case "findNodes": {
        const root = a.within ? await this.one(a.within) : this.host.page;
        if (!hasChildren(root)) throw new ActionError(`"${root.name}" has no children to search`);
        const q = a.query;
        const limit = a.limit ?? 50;
        const found = (root as ChildrenMixin)
          .findAll(
            (n) =>
              (q.name === undefined || n.name === q.name) &&
              (q.nameContains === undefined || n.name.toLowerCase().includes(q.nameContains.toLowerCase())) &&
              (q.id === undefined || n.id === (this.host.idMap?.get(q.id) ?? q.id)) &&
              (q.type === undefined || n.type === q.type),
          )
          .slice(0, limit);
        return this.record(a, found, found.map(summary));
      }
      case "inspectNode": {
        const node = await this.one(a.node);
        return this.record(a, [node], this.inspect(node, a.depth ?? 2));
      }
      case "createPage": {
        const page = figma.createPage();
        page.name = a.name;
        this.host.createdPages.push(page);
        this.result.created.push(page.id);
        return this.record(a, [page], summary(page));
      }
      case "duplicateNode": {
        const node = this.scene(await this.one(a.node), "duplicateNode");
        const parent = a.targetParent ? await this.one(a.targetParent) : node.parent;
        if (!parent || !("appendChild" in parent)) throw new ActionError(`"${parent?.name ?? "?"}" can't hold layers`);
        if (parent.type === "INSTANCE") throw new ActionError(`Can't add layers inside the instance "${parent.name}"`);
        const copy = node.clone();
        const container = parent as BaseNode & ChildrenMixin;
        if (parent === node.parent) container.insertChild(container.children.indexOf(node) + 1, copy);
        else container.appendChild(copy);
        if (a.name) copy.name = a.name;
        if (a.position?.x !== undefined) copy.x = a.position.x;
        if (a.position?.y !== undefined) copy.y = a.position.y;
        this.result.created.push(copy.id);
        return this.record(a, [copy], summary(copy));
      }
      case "deleteNode": {
        const nodes = await this.many(a.node);
        for (const n of nodes) {
          if (n.type === "PAGE" && (n === this.host.page || n === figma.currentPage)) throw new ActionError("Can't delete the page the stage works on");
          if (n.type === "DOCUMENT") throw new ActionError("Can't delete the document");
          (n as SceneNode).remove();
        }
        return this.record(a, null, { deleted: nodes.length });
      }
      case "renameNode": {
        const node = await this.one(a.node);
        node.name = a.name;
        this.touch(node);
        return this.record(a, [node], summary(node));
      }
      case "arrangeInGrid": {
        const nodes = (await this.many(a.nodes)).map((n) => this.scene(n, "arrangeInGrid"));
        const parent = nodes[0]?.parent as (BaseNode & Partial<FrameNode>) | null;
        if (parent && "layoutMode" in parent && parent.layoutMode !== "NONE") {
          throw new ActionError(`"${parent.name}" uses auto layout; it arranges its children itself`);
        }
        const gapX = typeof a.gap === "number" ? a.gap : a.gap.x;
        const gapY = typeof a.gap === "number" ? a.gap : a.gap.y;
        const cellW = Math.max(...nodes.map((n) => n.width));
        const cellH = Math.max(...nodes.map((n) => n.height));
        const origin = a.origin ?? { x: nodes[0].x, y: nodes[0].y };
        nodes.forEach((n, i) => {
          n.x = origin.x + (i % a.columns) * (cellW + gapX);
          n.y = origin.y + Math.floor(i / a.columns) * (cellH + gapY);
        });
        return this.record(a, nodes, nodes.map(summary));
      }
      case "setText": {
        const node = this.text(await this.one(a.node), "setText");
        await this.setCharacters(node, String(a.text), "setText");
        return this.record(a, [node], summary(node));
      }
      case "setTextStyleRanges": {
        const node = this.text(await this.one(a.node), "setTextStyleRanges");
        if (!(await this.loadFonts(node))) {
          this.result.log.push(`setTextStyleRanges: skipped "${node.name}" because a font is missing`);
          return this.record(a, [node], summary(node));
        }
        const text = node.characters;
        const spans: [number, number][] = [];
        for (const r of a.ranges) {
          if ("match" in r) {
            const escaped = r.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const re = new RegExp(r.wholeWord ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped, `g${r.caseSensitive ? "" : "i"}u`);
            for (const m of text.matchAll(re)) spans.push([m.index!, m.index! + m[0].length]);
          } else {
            const start = Math.min(r.start, text.length);
            const end = Math.min(r.end, text.length);
            if (end > start) spans.push([start, end]);
          }
        }
        const s = a.style;
        let applied = 0;
        for (const [start, end] of spans) {
          if (s.fontFamily || s.fontStyle) {
            const current = node.getRangeFontName(start, end);
            const base = current === figma.mixed ? node.getRangeAllFontNames(start, end)[0] : current;
            const font = { family: s.fontFamily ?? base.family, style: s.fontStyle ?? base.style };
            try {
              await figma.loadFontAsync(font);
              node.setRangeFontName(start, end, font);
            } catch {
              this.result.findings.push({ type: "font-style-missing", message: `"${font.family} ${font.style}" isn't available for "${node.name}"`, nodeId: node.id });
              continue;
            }
          }
          if (s.fontSize !== undefined) node.setRangeFontSize(start, end, s.fontSize);
          if (s.fill) {
            const { color, opacity } = parseColor(s.fill);
            node.setRangeFills(start, end, [{ type: "SOLID", color, opacity }]);
          }
          if (s.textDecoration) node.setRangeTextDecoration(start, end, s.textDecoration);
          applied++;
        }
        if (applied) this.touch(node);
        return this.record(a, [node], { ...summary(node), ranges: spans.length, styled: applied });
      }
      case "repeatChild": {
        const container = await this.one(a.container);
        if (!hasChildren(container) || container.type === "INSTANCE") throw new ActionError(`"${container.name}" can't hold copies`);
        const parent = container as BaseNode & ChildrenMixin;
        const template = this.scene(await this.one(a.templateChild, container), "repeatChild");
        if (a.clearPrevious !== false) {
          for (const child of [...parent.children]) if (child !== template && child.getPluginData("dopplCloneOf") === template.id) child.remove();
        }
        const copies: SceneNode[] = [];
        let index = parent.children.indexOf(template);
        for (const [i, item] of a.items.entries()) {
          if (this.host.isCancelled()) throw new CancelledInFigma();
          const copy = template.clone();
          parent.insertChild(++index, copy);
          copy.visible = true;
          copy.setPluginData("dopplCloneOf", template.id);
          copy.name = a.namePattern ? format(a.namePattern, item) : `${template.name} ${i + 1}`;
          for (const [layerName, binding] of Object.entries(a.bindings)) {
            const target = copy.name === layerName ? copy : this.findByName(copy, layerName);
            if (!target) throw new ActionError(`No layer named "${layerName}" inside "${template.name}"`);
            let value: string;
            if (binding.includes("{")) value = format(binding, item);
            else if (binding in item) value = String(item[binding] ?? "");
            else throw new ActionError(`The items have no "${binding}" field (bound to "${layerName}")`);
            await this.setCharacters(this.text(target, "repeatChild"), value, "repeatChild");
          }
          copies.push(copy);
        }
        if ((a.template ?? "hide") === "hide") template.visible = false;
        else if (a.template === "remove") template.remove();
        this.result.created.push(...copies.map((c) => c.id));
        this.touch(container);
        return this.record(a, copies, copies.map(summary));
      }
      case "setImageFill": {
        const node = this.scene(await this.one(a.node), "setImageFill");
        if (!("fills" in node)) throw new ActionError(`"${node.name}" can't have an image fill`);
        let image: Image;
        try {
          image = figma.createImage(figma.base64Decode(a.image.bytes));
        } catch (err) {
          throw new ActionError(`Figma couldn't use the image ${a.image.name ?? ""}: ${(err as Error).message}`);
        }
        const scaleMode = a.scaleMode ?? "FILL";
        (node as GeometryMixin).fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode }];
        const size = await image.getSizeAsync();
        const sx = node.width / size.width;
        const sy = node.height / size.height;
        const scale = scaleMode === "FIT" ? Math.min(sx, sy) : Math.max(sx, sy);
        if (scale > 1.05) {
          this.result.findings.push({
            type: "upscaled-image",
            message: `"${node.name}" shows ${a.image.name ?? "its image"} at ${scale.toFixed(1)}× its pixel size, so it looks blurry`,
            nodeId: node.id,
          });
        }
        this.touch(node);
        return this.record(a, [node], summary(node));
      }
      case "placeSvg": {
        const target = this.scene(await this.one(a.node), "placeSvg");
        let placed: FrameNode;
        try {
          placed = figma.createNodeFromSvg(a.svg);
        } catch (err) {
          throw new ActionError(`Figma couldn't read the SVG: ${(err as Error).message}`);
        }
        if (a.name) placed.name = a.name;
        const fit = a.fit ?? "contain";
        const s = fit === "cover" ? Math.max(target.width / placed.width, target.height / placed.height) : Math.min(target.width / placed.width, target.height / placed.height);
        if (Number.isFinite(s) && s > 0) placed.rescale(s);
        const inside = "appendChild" in target && target.type !== "INSTANCE";
        const holder = (inside ? target : target.parent) as BaseNode & ChildrenMixin & Partial<FrameNode>;
        if (a.name) for (const c of [...holder.children]) if (c.name === a.name && c !== target) c.remove();
        if (inside) {
          holder.appendChild(placed);
          placed.x = (target.width - placed.width) / 2;
          placed.y = (target.height - placed.height) / 2;
        } else {
          holder.insertChild(holder.children.indexOf(target) + 1, placed);
          placed.x = target.x + (target.width - placed.width) / 2;
          placed.y = target.y + (target.height - placed.height) / 2;
        }
        if ("layoutMode" in holder && holder.layoutMode !== "NONE") placed.layoutPositioning = "ABSOLUTE";
        this.result.created.push(placed.id);
        this.touch(placed);
        return this.record(a, [placed], summary(placed));
      }
      case "setProperties": {
        const nodes = (await this.many(a.node)).map((n) => this.scene(n, "setProperties"));
        const p = a.props;
        for (const node of nodes) {
          const any = node as SceneNode & Partial<FrameNode>;
          if (p.visible !== undefined) node.visible = p.visible;
          if (p.opacity !== undefined) {
            if (!("opacity" in node)) throw new ActionError(`"${node.name}" has no opacity`);
            (node as BlendMixin).opacity = p.opacity;
          }
          if (p.fills !== undefined) {
            if (!("fills" in node)) throw new ActionError(`"${node.name}" has no fills`);
            const list = typeof p.fills === "string" ? [{ type: "SOLID" as const, color: p.fills }] : p.fills;
            (node as GeometryMixin).fills = list.map((f) => {
              const { color, opacity } = parseColor(f.color);
              return { type: "SOLID", color, opacity: f.opacity ?? opacity } as SolidPaint;
            });
          }
          if (p.cornerRadius !== undefined) {
            if (!("cornerRadius" in node)) throw new ActionError(`"${node.name}" has no corner radius`);
            (node as CornerMixin).cornerRadius = p.cornerRadius;
          }
          const layout = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "itemSpacing"] as const;
          for (const key of layout) {
            if (p[key] === undefined) continue;
            if (!("layoutMode" in node) || any.layoutMode === "NONE") throw new ActionError(`"${node.name}" doesn't use auto layout, so it has no ${key}`);
            (any as FrameNode)[key] = p[key]!;
          }
          if (p.width !== undefined || p.height !== undefined) {
            if (!("resize" in node)) throw new ActionError(`"${node.name}" can't be resized`);
            if (node.type === "TEXT" && !(await this.loadFonts(node))) continue;
            (node as FrameNode).resize(p.width ?? node.width, p.height ?? node.height);
          }
          if (p.x !== undefined) node.x = p.x;
          if (p.y !== undefined) node.y = p.y;
          this.touch(node);
        }
        return this.record(a, nodes, nodes.map(summary));
      }
      case "exportNode": {
        const node = this.scene(await this.one(a.node), "exportNode");
        const settings: ExportSettings =
          a.format === "SVG" || a.format === "PDF"
            ? ({ format: a.format } as ExportSettings)
            : { format: a.format, constraint: { type: "SCALE", value: a.scale ?? 1 } };
        const bytes = await node.exportAsync(settings);
        this.result.exports.push({
          fileName: a.fileName ?? node.name,
          format: a.format,
          folder: a.folder,
          nodeId: node.id,
          data: figma.base64Encode(bytes),
          output: a.output,
        });
        // The file path is known once Doppl writes it; the value here is the export's position.
        const value = { export: this.result.exports.length - 1, nodeId: node.id };
        if (a.id) {
          this.named.set(a.id, [node]);
          this.result.results[a.id] = value;
        }
        this.result.steps.push({ action: a.action, id: a.id, result: value });
        return;
      }
      case "measure": {
        const node = this.scene(await this.one(a.node), "measure");
        const boundary = a.boundary ? await this.one(a.boundary) : node;
        const measured = await this.measure(node, boundary, a.check !== false);
        return this.record(a, [node], measured);
      }
    }
  }

  /** Text that doesn't fit, and layers sticking out of the boundary. */
  async measure(node: SceneNode, boundary: BaseNode, check: boolean) {
    const box = boxOf(node);
    const bbox = boxOf(boundary);
    const textOverflow: { id: string; node: string; kind: "box" | "container"; container?: string }[] = [];
    const outside: { id: string; node: string; edge: string }[] = [];
    const all: SceneNode[] = [node, ...("findAll" in node ? (node as ChildrenMixin).findAll((n) => n.visible !== false).slice(0, 2000) : [])];
    for (const n of all) {
      if (n.type !== "TEXT" || n.visible === false) continue;
      const t = n as TextNode;
      if ((t.textAutoResize === "NONE" || t.textAutoResize === "TRUNCATE") && (await this.loadFonts(t))) {
        const probe = t.clone();
        probe.textTruncation = "DISABLED";
        probe.textAutoResize = "HEIGHT";
        const overflows = probe.height > t.height + 0.5;
        probe.remove();
        if (overflows) textOverflow.push({ id: t.id, node: t.name, kind: "box" });
      }
      let container: BaseNode | null = t.parent;
      while (container && !["FRAME", "COMPONENT", "INSTANCE"].includes(container.type)) container = container.parent;
      const tb = boxOf(t);
      const cb = container ? boxOf(container) : null;
      if (tb && cb && edgeOutside(tb, cb)) textOverflow.push({ id: t.id, node: t.name, kind: "container", container: container!.name });
    }
    if (bbox) {
      for (const n of all) {
        if (n === boundary || n.visible === false) continue;
        const nb = boxOf(n);
        const edge = nb ? edgeOutside(nb, bbox) : null;
        if (edge && !outside.some((o) => (n.parent as BaseNode | null)?.id === o.id)) outside.push({ id: n.id, node: n.name, edge });
        if (outside.length >= 50) break;
      }
    }
    if (check) {
      for (const o of textOverflow) {
        this.result.findings.push({
          type: "text-overflow",
          message: o.kind === "box" ? `"${o.node}" doesn't fit its text box` : `"${o.node}" runs past "${o.container}"`,
          nodeId: o.id,
        });
      }
      for (const o of outside) {
        this.result.findings.push({ type: "outside-boundary", message: `"${o.node}" sticks out of "${boundary.name}" at the ${o.edge}`, nodeId: o.id });
      }
    }
    return { bounds: box ? { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) } : null, textOverflow, outside };
  }

  async runAll(actions: WireActionT[]): Promise<ActionRunResult> {
    for (const [i, a] of actions.entries()) {
      if (this.host.isCancelled()) throw new CancelledInFigma();
      this.host.progress(`${a.action} (${i + 1} of ${actions.length})`);
      try {
        await this.run(a);
      } catch (err) {
        if (err instanceof CancelledInFigma) throw err;
        this.result.ok = false;
        this.result.error = { index: i, action: a.action, message: (err as Error).message || String(err) };
        break;
      }
    }
    return this.result;
  }
}

export function runActions(actions: WireActionT[], host: Host): Promise<ActionRunResult> {
  return new Interpreter(host).runAll(actions);
}

/** Checks a frame the routine made: text cut off by a clipping frame, missing fonts, blurry images. */
export async function checkNode(figma: PluginAPI, frame: SceneNode): Promise<Finding[]> {
  const findings: Finding[] = [];
  const box = boxOf(frame);
  if (!box || !("findAll" in frame)) return findings;
  const clips = "clipsContent" in frame && (frame as FrameNode).clipsContent;
  const nodes = (frame as ChildrenMixin).findAll((n) => n.visible !== false).slice(0, 1000);
  for (const n of nodes) {
    if (n.type === "TEXT") {
      if ((n as TextNode).hasMissingFont) findings.push({ type: "font-missing", message: `Missing font in "${n.name}"`, nodeId: n.id });
      const nb = boxOf(n);
      const edge = clips && nb ? edgeOutside(nb, box, 1) : null;
      if (edge) findings.push({ type: "cut-off", message: `"${n.name}" is cut off at the ${edge} edge`, nodeId: n.id });
    }
    if ("fills" in n && Array.isArray((n as GeometryMixin).fills)) {
      for (const fill of (n as GeometryMixin).fills as Paint[]) {
        if (fill.type !== "IMAGE" || fill.visible === false || !fill.imageHash) continue;
        if (fill.scaleMode !== "FILL" && fill.scaleMode !== "FIT") continue;
        const image = figma.getImageByHash(fill.imageHash);
        if (!image) continue;
        const size = await image.getSizeAsync();
        const sx = n.width / size.width;
        const sy = n.height / size.height;
        const scale = fill.scaleMode === "FILL" ? Math.max(sx, sy) : Math.min(sx, sy);
        if (scale > 1.05) {
          findings.push({ type: "upscaled-image", message: `"${n.name}" shows its image at ${scale.toFixed(1)}× its pixel size, so it looks blurry`, nodeId: n.id });
        }
      }
    }
  }
  return findings;
}

/** Maps every node id on `from` to the id of the same node on its clone `to` (same structure, same order). */
export function mapIds(from: BaseNode, to: BaseNode, map = new Map<string, string>()): Map<string, string> {
  map.set(from.id, to.id);
  if (hasChildren(from) && hasChildren(to)) {
    const a = from.children;
    const b = to.children;
    for (let i = 0; i < Math.min(a.length, b.length); i++) mapIds(a[i], b[i], map);
  }
  return map;
}
