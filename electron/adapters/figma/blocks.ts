import type { CompositeAction, HelperDef } from "../../core/blocks/types";

// Figma building blocks: composite actions (named macros of catalog actions). A routine uses one as
// { "action": "block", "name": "<name>", "args": { … }, "id"?: "<id>", "output"?: "<output key>" }; Doppl expands it
// into catalog actions (core/blocks/composites.ts) before checking the routine and before the plugin runs it.

const composite = (c: CompositeAction) => JSON.stringify(c);

const fillTemplate: CompositeAction = {
  params: [
    { name: "template", type: "node reference", doc: "The frame to copy, e.g. \"Label\"" },
    { name: "texts", type: "object", optional: true, doc: "Text layer name → text, e.g. { \"Name\": \"{{item.name}}\" }" },
    { name: "images", type: "object", optional: true, doc: "Layer name → image file, e.g. { \"Photo\": \"{{matched.photos}}\" }" },
    { name: "name", type: "string", optional: true, doc: "Name of the copy" },
  ],
  actions: [
    { action: "duplicateNode", id: "copy", node: "{{args.template}}", name: "{{args.name}}" },
    { $each: "{{args.texts}}", do: { action: "setText", node: "$copy.#{{each.key}}", text: "{{each.value}}" } },
    { $each: "{{args.images}}", do: { action: "setImageFill", node: "$copy.#{{each.key}}", image: { file: "{{each.value}}" }, scaleMode: "FILL" } },
    { action: "measure", node: "$copy" },
  ],
  result: "copy",
};

const fillTemplateAndExport: CompositeAction = {
  params: [
    ...fillTemplate.params,
    { name: "format", type: "\"PNG\" | \"JPG\" | \"SVG\" | \"PDF\"" },
    { name: "scale", type: "number", optional: true, doc: "PNG/JPG only (default 1)" },
    { name: "fileName", type: "string", optional: true, doc: "Without extension, e.g. \"{{item.sku}}\"" },
  ],
  actions: [
    ...fillTemplate.actions,
    { action: "exportNode", node: "$copy", format: "{{args.format}}", scale: "{{args.scale}}", fileName: "{{args.fileName}}", output: "{{args.output}}" },
  ],
  result: "copy",
};

const figma = (def: Omit<HelperDef, "app" | "source" | "version"> & { version?: number }): HelperDef => ({ app: "figma", source: "builtin", version: 1, ...def });

export const FIGMA_BLOCKS: HelperDef[] = [
  figma({
    id: "figma.fillTemplate",
    set: "templates",
    call: "fillTemplate",
    summary: "Copies a template frame and fills its text layers and images by layer name.",
    signature: { params: fillTemplate.params, returns: "the copy" },
    sideEffects: ["adds a copy of the template"],
    doc: 'Block "fillTemplate": copies a template frame and fills text layers and images by layer name, then measures it (text that doesn\'t fit is flagged).\nExample: { "action": "block", "name": "fillTemplate", "id": "label", "args": { "template": "Label", "texts": { "Name": "{{item.name}}", "Price": "{{item.price}}" } } }, then use "$label".',
    tests: [
      {
        name: "fills a copy of the template",
        inputs: {},
        script: JSON.stringify([{ action: "block", name: "fillTemplate", id: "label", args: { template: "Label", texts: { Name: "Fig jam" } } }]),
        checks: [{ type: "noRunErrors" }],
      },
    ],
    code: composite(fillTemplate),
  }),
  figma({
    id: "figma.fillTemplateAndExport",
    set: "templates",
    call: "fillTemplateAndExport",
    summary: "Copies a template frame, fills its texts and images by layer name, and exports it to an output.",
    signature: { params: fillTemplateAndExport.params, returns: "the copy (its file goes to the block's output)" },
    sideEffects: ["adds a copy of the template", "writes a file"],
    doc: 'Block "fillTemplateAndExport": fillTemplate, then exports the copy; give the routine output as the block\'s "output".\nExample: { "action": "block", "name": "fillTemplateAndExport", "id": "label", "output": "labels", "args": { "template": "Label", "texts": { "Name": "{{item.name}}" }, "format": "PNG", "scale": 2, "fileName": "{{item.sku}}" } }',
    tests: [
      {
        name: "exports a filled copy",
        inputs: {},
        script: JSON.stringify([{ action: "block", name: "fillTemplateAndExport", output: "files", args: { template: "Label", texts: { Name: "Fig jam" }, format: "PNG", fileName: "fig" } }]),
        checks: [{ type: "fileExtension", port: "files", is: "png" }],
      },
    ],
    code: composite(fillTemplateAndExport),
  }),
];
