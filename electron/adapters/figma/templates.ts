import type { RoutineTemplate } from "../types";

// Real Figma routines for the Doppel plugin (figma-plugin/code.js runs them). They are shown to the
// model as examples of how Figma routines are written; see modelGuide.ts for the contract.

const FORMATS = [
  ["instagram-post", "Instagram post", 1080, 1080],
  ["instagram-portrait", "Instagram portrait", 1080, 1350],
  ["instagram-story", "Instagram story", 1080, 1920],
  ["facebook-post", "Facebook post", 1200, 630],
  ["linkedin-post", "LinkedIn post", 1200, 627],
  ["x-post", "X post", 1600, 900],
  ["x-header", "X header", 1500, 500],
  ["youtube-thumbnail", "YouTube thumbnail", 1280, 720],
] as const;

const socialFormats = `// Make one frame per format from the source frame: scale the content to fit, center it, and
// place the new frames in a row to the right of the source.
const source = doppel.findFrame(params.sourceFrame);
if (!source) throw new Error('There is no frame called "' + params.sourceFrame + '" on this page.');
await doppel.loadFonts(source);
let x = source.x + source.width + 200;
for (const value of params.formats) {
  const [id, size] = String(value).split(":");
  const [width, height] = size.split("x").map(Number);
  const frame = source.clone();
  frame.name = doppel.format(params.namingPattern || "{format}", { format: id, width, height, source: source.name });
  const scale = Math.min(width / source.width, height / source.height);
  frame.rescale(scale);
  const dx = (width - frame.width) / 2;
  const dy = (height - frame.height) / 2;
  frame.resizeWithoutConstraints(width, height);
  for (const child of frame.children) {
    child.x += dx;
    child.y += dy;
  }
  frame.x = x;
  frame.y = source.y;
  x += width + 100;
  doppel.output({ key: "format-" + id, label: id.replace(/-/g, " ") + " " + width + "×" + height, nodeId: frame.id });
}
return { made: params.formats.length };`;

const exportFrames = `// Export the frames on this page (optionally only those whose name contains a word) as files.
const filter = String(params.nameContains || "").toLowerCase();
const frames = doppel.frames().filter((f) => !filter || f.name.toLowerCase().includes(filter));
if (frames.length === 0) throw new Error("No frames on this page match.");
for (const frame of frames) {
  const fileName = doppel.format(params.namingPattern || "{name}", { name: frame.name, file: figma.root.name });
  await doppel.exportNode(frame, { folder: params.outputFolder, fileName, format: params.format || "PNG", scale: Number(params.scale) || 2 });
  doppel.output({ key: frame.id, label: frame.name, nodeId: frame.id });
}
return { exported: frames.length };`;

const renameLayers = `// Rename the layers inside each frame on this page with a pattern. Dry run only lists the new names.
// An existing number prefix ("03_") is replaced, not doubled.
const details = [];
for (const frame of doppel.frames()) {
  let index = 1;
  for (const node of frame.findAll(() => true)) {
    const next = doppel.format(params.pattern || "{frame}/{name}", {
      frame: frame.name,
      name: node.name.replace(/^\\d+_/, ""),
      index: String(index++).padStart(2, "0"),
    });
    if (next !== node.name) {
      details.push({ label: node.name, value: next });
      if (!params.dryRun) node.name = next;
    }
  }
}
doppel.output({ key: "layers", label: params.dryRun ? "Layer names (dry run, nothing changed)" : "Renamed " + details.length + " layers", details });
return { renamed: params.dryRun ? 0 : details.length };`;

export const FIGMA_TEMPLATES: RoutineTemplate[] = [
  {
    id: "figma-social-formats",
    appId: "figma",
    name: "Social formats from master visual",
    description: "Turns one master frame into a frame per social format, scaled to fit and centered.",
    keywords: ["resize", "social", "format", "formats", "instagram", "story", "linkedin", "facebook", "campaign", "sizes", "banner", "adapt", "variants"],
    steps: [
      "Find the master frame on the page",
      "Make a copy for each chosen format",
      "Scale the content to fit and center it",
      "Name each frame after its format",
    ],
    params: [
      { key: "sourceFrame", label: "Source frame", type: "select", required: true, optionsSource: "frames" },
      {
        key: "formats",
        label: "Formats",
        type: "formatList",
        required: true,
        default: FORMATS.map(([id, , w, h]) => `${id}:${w}x${h}`),
        options: FORMATS.map(([id, label, w, h]) => ({ value: `${id}:${w}x${h}`, label: `${label} ${w}×${h}` })),
      },
      { key: "namingPattern", label: "Frame naming pattern", type: "text", required: true, default: "{format}", help: "Tokens: {format}, {width}, {height}, {source}" },
    ],
    script: socialFormats,
    modifiesDocument: true,
    qcProfile: "web",
    requiredFonts: [],
  },
  {
    id: "figma-export-frames",
    appId: "figma",
    name: "Export frames",
    description: "Exports the frames on the page as PNG, JPG, SVG or PDF files into a folder.",
    keywords: ["export", "png", "jpg", "svg", "pdf", "download", "assets", "files", "deliver"],
    steps: ["Pick the frames on the page", "Export each one at the chosen scale", "Name the files with the pattern"],
    params: [
      { key: "outputFolder", label: "Output folder", type: "folder", required: true },
      {
        key: "format",
        label: "Format",
        type: "select",
        required: true,
        default: "PNG",
        options: ["PNG", "JPG", "SVG", "PDF"].map((v) => ({ value: v, label: v })),
      },
      { key: "scale", label: "Scale", type: "number", required: true, default: 2, min: 0.5, max: 4 },
      { key: "nameContains", label: "Only frames whose name contains", type: "text", required: false, default: "" },
      { key: "namingPattern", label: "File naming pattern", type: "text", required: true, default: "{name}", help: "Tokens: {name}, {file}" },
    ],
    script: exportFrames,
    modifiesDocument: false,
    qcProfile: "web",
    requiredFonts: [],
  },
  {
    id: "figma-rename-layers",
    appId: "figma",
    name: "Rename layers by pattern",
    description: "Renames every layer in the page's frames with a pattern. Use dry run to preview first.",
    keywords: ["rename", "layer", "layers", "organize", "naming", "tidy", "clean"],
    steps: ["Go through each frame on the page", "Build each layer's new name from the pattern", "Rename, or only list the names on a dry run"],
    params: [
      { key: "pattern", label: "Naming pattern", type: "text", required: true, default: "{frame}/{name}", help: "Tokens: {frame}, {index}, {name}" },
      { key: "dryRun", label: "Dry run (preview names, change nothing)", type: "boolean", required: false, default: true },
    ],
    script: renameLayers,
    modifiesDocument: true,
    qcProfile: "web",
    requiredFonts: [],
  },
];
