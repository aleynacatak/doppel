import { z } from "zod";

// The Figma action catalog. Figma routines are declarative action lists run by a fixed interpreter in the Doppl
// plugin (figma-plugin/src/interpreter.ts); no code strings are executed. The same schemas validate routines in
// Doppl ("authoring": placeholders allowed, images and SVGs by reference) and requests in the plugin ("wire":
// placeholders expanded, files already read into bytes). The model gets them as JSON Schema (figmaCatalogJsonSchema).

/** A value that is only a placeholder, e.g. "{{settings.columns}}". */
export const PLACEHOLDER_ONLY = /^\{\{\s*[A-Za-z_$][\w$.]*\s*\}\}$/;

export const FIGMA_NODE_TYPES = [
  "FRAME",
  "GROUP",
  "COMPONENT",
  "COMPONENT_SET",
  "INSTANCE",
  "TEXT",
  "RECTANGLE",
  "ELLIPSE",
  "VECTOR",
  "LINE",
  "POLYGON",
  "STAR",
  "SECTION",
  "BOOLEAN_OPERATION",
] as const;

export const BARCODE_TYPES = ["ean13", "ean8", "upca", "code128"] as const;
export const EXPORT_FORMATS = ["PNG", "JPG", "SVG", "PDF"] as const;

type Mode = "authoring" | "wire";

const toNumber = (v: unknown) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v);
const toBoolean = (v: unknown) => (v === "true" ? true : v === "false" ? false : v);

const refDescription =
  'Node reference: a node id ("12:34"), a name ("Card"), a path of names ("Card/Title"), "page:<page name>", ' +
  '"$<actionId>" for an earlier action\'s result, or "$<actionId>.#<descendant name>" (chainable, e.g. "$card.#header.#title")';

// In authoring mode a number or boolean may also be a placeholder; on the wire it is a real value (strings like
// "3" or "true" from data files are converted). Number and boolean schemas are typed as their wire form (what the
// interpreter reads); the other mode-dependent parts keep each mode's inferred type.
type Pick2<M extends Mode, A, W> = M extends "authoring" ? A : W;

function makeCatalog<M extends Mode>(mode: M) {
  const placeholder = z.string().regex(PLACEHOLDER_ONLY);
  const num = (s: z.ZodNumber) => (mode === "authoring" ? z.union([s, placeholder]) : z.preprocess(toNumber, s)) as unknown as z.ZodNumber;
  const bool = () => (mode === "authoring" ? z.union([z.boolean(), placeholder]) : z.preprocess(toBoolean, z.boolean())) as unknown as z.ZodBoolean;

  const ref = z.string().min(1).describe(refDescription);
  const refs = z.union([ref, z.array(ref).min(1)]).describe("One reference (a $result that is a list counts as all of them) or a list");
  const color = z
    .string()
    .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$|^\{\{.+\}\}$/)
    .describe('Hex color, e.g. "#1A1A1A" or "#1A1A1A80"');
  const paint = z.object({ type: z.literal("SOLID"), color, opacity: num(z.number().min(0).max(1)).optional() });
  const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
  const items = z.array(z.record(z.string(), scalar));

  const imageAuthoring = z
          .union([
            z.object({ file: z.string().min(1).describe("A file path from a placeholder, e.g. {{item.path}}") }),
            z.object({
              folder: z.string().min(1).describe("A folder input, e.g. {{inputs.images}}"),
              name: z.string().min(1).describe("File name in that folder, with or without extension, e.g. {{item.image}}"),
            }),
            z
              .object({
                files: z.union([z.array(z.string()), placeholder]).describe('A list of files, e.g. "{{inputs.cutouts}}"'),
                name: z.string().min(1).describe("The file to pick, by name with or without extension, e.g. {{item.image}}"),
              })
              .describe("Pick one file by name from a list, e.g. a fileList input"),
          ])
          .describe("PNG, JPEG or GIF up to 4096 px; Doppl reads the file and sends it to Figma");
  const imageWire = z.object({ bytes: z.string().min(1), name: z.string().optional() });
  const image = (mode === "authoring" ? imageAuthoring : imageWire) as Pick2<M, typeof imageAuthoring, typeof imageWire>;
  const barcode = z.object({
    type: z.enum(BARCODE_TYPES),
    value: z.union([z.string(), z.number()]).describe("Digits (EAN/UPC; the check digit is added or verified) or text (Code 128)"),
    showText: bool().optional(),
  });
  const svgAuthoring = z
          .union([
            z.string().min(1).describe("SVG markup"),
            z.object({ file: z.string().min(1).describe("An .svg file path from a placeholder") }),
            z.object({ barcode }).describe("A barcode Doppl draws as SVG"),
          ])
          .describe("What to place");
  const svgWire = z.string().min(1);
  const svg = (mode === "authoring" ? svgAuthoring : svgWire) as Pick2<M, typeof svgAuthoring, typeof svgWire>;

  const common = {
    id: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
      .optional()
      .describe('Names this action\'s result so later actions can use it as "$id"'),
    output: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
      .optional()
      .describe("Also add this action's result to the routine output with this key (exportNode → the file path)"),
  };
  const action = <T extends string, S extends z.ZodRawShape>(name: T, description: string, shape: S) =>
    z.object({ action: z.literal(name), ...common, ...shape }).describe(description);

  const actions = [
    action("getSelection", "The nodes the designer has selected (summaries). Result: a list.", {}),
    action("findNodes", "Nodes matching a query, searched in `within` or the routine's page. Result: a list.", {
      query: z
        .object({
          name: z.string().optional().describe("Exact name"),
          nameContains: z.string().optional(),
          id: z.string().optional(),
          type: z.enum(FIGMA_NODE_TYPES).optional(),
        })
        .refine((q) => q.name !== undefined || q.nameContains !== undefined || q.id !== undefined || q.type !== undefined, {
          message: "Give at least one of name, nameContains, id or type",
        }),
      within: ref.optional(),
      limit: num(z.number().int().min(1).max(500)).optional(),
    }),
    action("inspectNode", "Structure of a node: names, types, text, fonts, auto layout, bounds and fills, `depth` levels down.", {
      node: ref,
      depth: num(z.number().int().min(0).max(6)).optional(),
    }),
    action("createPage", "Adds a page. Result: the page (use it as targetParent).", { name: z.string().min(1) }),
    action("duplicateNode", "Duplicates a node into `targetParent` (default: the same parent). Result: the copy.", {
      node: ref,
      targetParent: ref.optional(),
      name: z.string().min(1).optional(),
      position: z.object({ x: num(z.number()).optional(), y: num(z.number()).optional() }).optional(),
    }),
    action("deleteNode", "Removes a node.", { node: refs }),
    action("renameNode", "Renames a node.", { node: ref, name: z.string().min(1) }),
    action("arrangeInGrid", "Positions nodes in a grid (same parent, not inside auto layout), in the given order.", {
      nodes: refs,
      columns: num(z.number().int().min(1).max(100)),
      gap: z.union([num(z.number().min(0)), z.object({ x: num(z.number().min(0)), y: num(z.number().min(0)) })]),
      origin: z.object({ x: num(z.number()), y: num(z.number()) }).optional(),
    }),
    action(
      "setText",
      'Sets the text of a text node, loading its fonts first. Missing fonts are reported, not fatal. "fit": true shrinks the whole text (0.5 pt steps, every size alike) until it fits its box and no word breaks in the middle, down to "minSize" (default 70% of its size); still too long is reported.',
      {
        node: ref,
        text: z.union([z.string(), z.number()]),
        fit: z.union([z.boolean(), z.object({ minSize: num(z.number().min(1).max(1000)).optional() })]).optional(),
      },
    ),
    action("setTextStyleRanges", "Styles parts of a text node, by position or by matching text.", {
      node: ref,
      ranges: z
        .array(
          z.union([
            z.object({ start: num(z.number().int().min(0)), end: num(z.number().int().min(0)) }),
            z.object({ match: z.string().min(1), wholeWord: bool().optional(), caseSensitive: bool().optional() }),
            z
              .object({
                matchAny: z.union([z.string(), z.array(z.string())]).describe('Several words or phrases, e.g. a data column "{{item.allergens}}"'),
                separator: z.string().min(1).optional().describe('Splits a text into words (default ",")'),
                wholeWord: bool().optional(),
                caseSensitive: bool().optional(),
              })
              .describe("Every occurrence of any of these words"),
          ]),
        )
        .min(1),
      style: z
        .object({
          fontFamily: z.string().min(1).optional(),
          fontStyle: z.string().min(1).optional().describe('e.g. "Bold", "Italic"'),
          fontSize: num(z.number().min(1).max(2000)).optional(),
          fill: color.optional(),
          textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
        })
        .refine((s) => Object.keys(s).length > 0, { message: "Give at least one style property" }),
    }),
    action(
      "repeatChild",
      "Fills a list or table: duplicates `templateChild` inside `container` once per item and sets descendant texts from `bindings`. Result: the copies.",
      {
        container: ref,
        templateChild: ref.describe("The child to copy (a name inside the container, or any reference)"),
        items: (mode === "authoring" ? z.union([items, placeholder]) : items) as Pick2<M, z.ZodUnion<[typeof items, z.ZodString]>, typeof items>,
        bindings: z
          .record(z.string(), z.string())
          .describe('Descendant layer name → item field ("price"), or a template with {field} tokens ("{qty} × {name}")'),
        template: z.enum(["hide", "remove", "keep"]).optional().describe('What happens to the template child afterwards (default "hide")'),
        namePattern: z.string().optional().describe('Name for each copy, with {field} tokens; default "<template> <n>"'),
        clearPrevious: bool().optional().describe("Remove copies made by earlier runs first (default true)"),
      },
    ),
    action("setImageFill", "Fills a shape or frame with an image.", {
      node: ref,
      image,
      scaleMode: z.enum(["FIT", "FILL", "CROP"]).optional(),
    }),
    action("placeSvg", "Places an SVG (or a barcode) scaled to fit inside the target node and centered. Result: the placed node.", {
      node: ref.describe("Target frame (the SVG goes inside it) or a placeholder shape (the SVG goes on top of it)"),
      svg,
      fit: z.enum(["contain", "cover"]).optional(),
      name: z.string().min(1).optional().describe("Name of the placed node; an earlier node with this name in the target is replaced"),
    }),
    action("setProperties", "Sets safe properties on nodes.", {
      node: refs,
      props: z
        .object({
          visible: bool().optional(),
          opacity: num(z.number().min(0).max(1)).optional(),
          fills: z.union([z.array(paint), color]).optional(),
          cornerRadius: num(z.number().min(0)).optional(),
          paddingTop: num(z.number().min(0)).optional(),
          paddingRight: num(z.number().min(0)).optional(),
          paddingBottom: num(z.number().min(0)).optional(),
          paddingLeft: num(z.number().min(0)).optional(),
          itemSpacing: num(z.number()).optional(),
          width: num(z.number().min(0.01)).optional(),
          height: num(z.number().min(0.01)).optional(),
          x: num(z.number()).optional(),
          y: num(z.number()).optional(),
        })
        .strict(),
    }),
    action("exportNode", "Exports a node as a file. Result: the file path.", {
      node: ref,
      format: z.enum(EXPORT_FORMATS),
      scale: num(z.number().min(0.1).max(10)).optional().describe("PNG/JPG only (default 1)"),
      fileName: z.string().min(1).optional().describe("Without extension; default: the node's name"),
      folder: z.string().min(1).optional().describe("Leave out: exports go into the routine's working folder (the designer's folders are read-only)"),
    }),
    action(
      "measure",
      "Bounds of a node, text that doesn't fit its box or container, and children outside `boundary` (default: the node itself). Problems become quality-check findings.",
      { node: ref, boundary: ref.optional(), check: bool().optional() },
    ),
  ] as const;

  const actionSchema = z.discriminatedUnion("action", actions);
  const list = z.object({ actions: z.array(actionSchema).min(1).max(300) });
  return { actionSchema, list };
}

const authoring = makeCatalog("authoring" as const);
const wire = makeCatalog("wire" as const);

/** One action as saved in a routine (placeholders allowed). */
export const AuthoringAction = authoring.actionSchema;
export const AuthoringActionList = authoring.list;
/** One action as the plugin receives it (placeholders expanded, files read). */
export const WireAction = wire.actionSchema;
export const WireActionList = wire.list;

export type WireActionT = z.infer<typeof WireAction>;
export type AuthoringActionT = z.infer<typeof AuthoringAction>;
export type FigmaActionName = WireActionT["action"];

export const FIGMA_ACTION_NAMES: FigmaActionName[] = WireAction.options.map((o) => o.shape.action.value);

export interface ActionIssue {
  /** e.g. "actions[3].node" */
  path: string;
  message: string;
}

function issuesOf(error: z.ZodError): ActionIssue[] {
  return error.issues.map((i) => ({
    path: i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, ""),
    message: i.message,
  }));
}

export function validateAuthoringActions(body: unknown): { ok: true } | { ok: false; issues: ActionIssue[] } {
  const res = AuthoringActionList.safeParse(body);
  return res.success ? { ok: true } : { ok: false, issues: issuesOf(res.error) };
}

export function parseWireActions(body: unknown): { ok: true; actions: WireActionT[] } | { ok: false; issues: ActionIssue[] } {
  const res = WireActionList.safeParse(body);
  return res.success ? { ok: true, actions: res.data.actions } : { ok: false, issues: issuesOf(res.error) };
}

/** The authoring catalog as JSON Schema, for the model. */
export function figmaCatalogJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AuthoringActionList, { unrepresentable: "any", io: "input" }) as Record<string, unknown>;
}
