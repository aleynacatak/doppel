import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { FIGMA_BLOCKS } from "../../adapters/figma/blocks";
import { INDESIGN_HELPERS } from "../../adapters/indesign/helpers";
import { PHOTOSHOP_HELPERS } from "../../adapters/photoshop/helpers";
import exported from "../../helpers/exported.json";
import type { AppId } from "../types";
import { analyzeCode } from "./analysis";
import { firstVersions, latestVersions } from "./select";
import type { CompositeAction, HelperDef, HelperPins, StageBlocks } from "./types";

// Every building block Doppl knows: the built-in ones (adapters' helper lists, plus blocks exported from a designer's
// library into electron/helpers/exported.json) and the designer's own promoted blocks (userData/helpers/<id>/<v>.json).
// A routine runs the versions it pinned; a routine saved before blocks were pinned runs every block's first version
// (the code it was made with). One registry per app process (set up with usePersonalDir at startup).

export const BUILTIN_BLOCKS: HelperDef[] = [...PHOTOSHOP_HELPERS, ...INDESIGN_HELPERS, ...FIGMA_BLOCKS, ...(exported as HelperDef[])];

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2)
    .map((w) => w.replace(/(ies|es|s)$/, (m) => (m === "ies" ? "y" : "")));

const STOP = new Set(["the", "and", "for", "with", "each", "every", "from", "into", "that", "this", "save", "make", "use", "photo", "image", "file", "png", "jpg"]);

export class BlockRegistry {
  private personal: HelperDef[] = [];
  private dir: string | null = null;

  constructor(private readonly builtins: HelperDef[] = BUILTIN_BLOCKS) {}

  /** The designer's library (userData/helpers); null: none (tests, evals). */
  usePersonalDir(dir: string | null) {
    this.dir = dir;
    this.reload();
  }

  get personalDir() {
    return this.dir;
  }

  reload() {
    this.personal = [];
    if (!this.dir || !fs.existsSync(this.dir)) return;
    for (const id of fs.readdirSync(this.dir)) {
      const folder = path.join(this.dir, id);
      if (id === "candidates" || !fs.statSync(folder).isDirectory()) continue;
      for (const file of fs.readdirSync(folder).filter((f) => f.endsWith(".json"))) {
        try {
          this.personal.push({ ...(JSON.parse(fs.readFileSync(path.join(folder, file), "utf8")) as HelperDef), source: "promoted" });
        } catch {
          // A damaged file is skipped; the others still load.
        }
      }
    }
  }

  async savePersonal(def: HelperDef): Promise<void> {
    if (!this.dir) throw new Error("No library folder for building blocks.");
    const folder = path.join(this.dir, def.id.replace(/[^A-Za-z0-9._-]/g, "-"));
    await fsp.mkdir(folder, { recursive: true });
    await fsp.writeFile(path.join(folder, `${def.version}.json`), JSON.stringify({ ...def, source: "promoted" }, null, 2));
    this.reload();
  }

  /** Every version of every block (of one app). */
  all(app?: AppId): HelperDef[] {
    const list = [...this.builtins, ...this.personal];
    return app ? list.filter((d) => d.app === app) : list;
  }

  latest(app?: AppId): HelperDef[] {
    return latestVersions(this.all(app));
  }

  get(id: string, version?: number): HelperDef | undefined {
    const list = this.all().filter((d) => d.id === id);
    if (version === undefined) return latestVersions(list)[0];
    return list.find((d) => d.version === version);
  }

  versions(id: string): number[] {
    return this.all()
      .filter((d) => d.id === id)
      .map((d) => d.version)
      .sort((a, b) => a - b);
  }

  /** The blocks a routine's code uses, at their newest versions. */
  pinsFor(app: AppId, routine: { kind: "script" | "actions"; script?: string; actions?: unknown }): HelperPins {
    const latest = this.latest(app);
    const ids =
      routine.kind === "actions"
        ? latest.filter((d) => JSON.stringify(routine.actions ?? []).includes(`"name":"${d.call}"`)).map((d) => d.id)
        : analyzeCode(routine.script ?? "", latest).blocks;
    return Object.fromEntries(ids.map((id) => [id, latest.find((d) => d.id === id)!.version]));
  }

  /** The block versions a stage runs with: pinned ones, else every built-in block's first version. */
  select(app: AppId, pins?: HelperPins): HelperDef[] {
    const builtin = firstVersions(this.builtins.filter((d) => d.app === app)).map((first) => (pins?.[first.id] ? (this.get(first.id, pins[first.id]) ?? first) : first));
    const own = Object.entries(pins ?? {})
      .filter(([id]) => !builtin.some((b) => b.id === id))
      .map(([id, v]) => this.get(id, v))
      .filter((d): d is HelperDef => !!d && d.app === app);
    return [...builtin, ...own];
  }

  resolve(app: AppId, pins?: HelperPins): StageBlocks {
    const defs = this.select(app, pins);
    if (app === "figma") return { composites: Object.fromEntries(defs.map((d) => [d.call, JSON.parse(d.code) as CompositeAction])) };
    return { code: defs.map((d) => ({ id: d.id, version: d.version, code: d.code })) };
  }

  /** Composite actions to check or run an action list with (pinned versions, or the newest for a draft). */
  composites(pins?: HelperPins, newest = false): Record<string, CompositeAction> {
    const defs = newest ? this.latest("figma") : this.select("figma", pins);
    return Object.fromEntries(defs.map((d) => [d.call, JSON.parse(d.code) as CompositeAction]));
  }

  /** Pinned blocks with a newer version. */
  updates(app: AppId, pins?: HelperPins): { id: string; call: string; from: number; to: number; summary: string }[] {
    if (!pins) return [];
    return Object.entries(pins)
      .map(([id, from]) => ({ def: this.get(id), from }))
      .filter(({ def, from }) => def && def.app === app && def.version > from)
      .map(({ def, from }) => ({ id: def!.id, call: def!.call, from, to: def!.version, summary: def!.summary }));
  }

  /** Newest blocks of an app, most relevant to the text first (ties keep the catalog order). */
  rank(app: AppId, text: string): HelperDef[] {
    const wanted = new Set(words(text).filter((w) => !STOP.has(w)));
    const scored = this.latest(app).map((d, i) => {
      const strong = new Set(words(`${d.call} ${d.summary} ${d.set}`));
      const weak = new Set(words(d.doc));
      let score = 0;
      for (const w of wanted) score += strong.has(w) ? 2 : weak.has(w) ? 1 : 0;
      return { d, score, i };
    });
    return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.d);
  }

  search(app: AppId, query: string, limit = 8): HelperDef[] {
    const wanted = new Set(words(query));
    return this.rank(app, query)
      .filter((d) => words(`${d.id} ${d.call} ${d.summary} ${d.set} ${d.doc}`).some((w) => wanted.has(w)))
      .slice(0, limit);
  }

  line(d: HelperDef): string {
    return `- ${d.call} (${d.id} v${d.version}${d.source === "promoted" ? ", your block" : ""}): ${d.summary}`;
  }

  docs(ids: string[]): string {
    const found = ids.map((id) => this.get(id) ?? this.latest().find((d) => d.call === id));
    return found.map((d, i) => (d ? `### ${d.call} (${d.id} v${d.version})\n${d.doc}` : `### ${ids[i]}\nNo building block with this id.`)).join("\n\n");
  }

  /** The compact index for a request: every block in one line, most relevant first, and the top ones in full. */
  indexText(app: AppId, request: string, full = 3): string {
    const ranked = this.rank(app, request);
    if (!ranked.length) return "";
    return [
      `Building blocks (tested helpers; build routines from these first), most relevant to the request first:`,
      ...ranked.map((d) => this.line(d)),
      "",
      "The most relevant ones in full:",
      this.docs(ranked.slice(0, full).map((d) => d.id)),
      "",
      'For the others, answer {"action":"get_helper_docs","ids":["<id>"]}; to find blocks by what they do, {"action":"search_helpers","query":"…"}.',
    ].join("\n");
  }

  /** The designer's own blocks in full (appended to a guide that already documents the built-in ones). */
  personalText(app: AppId): string {
    const own = latestVersions(this.personal.filter((d) => d.app === app));
    return own.length ? `\n\nYour own building blocks (promoted from your routines; use them like the helpers):\n${this.docs(own.map((d) => d.id))}` : "";
  }
}

/** The app's registry (personal library set up in config). */
export const blocks = new BlockRegistry();
