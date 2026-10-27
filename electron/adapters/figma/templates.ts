import type { MockFormat } from "../mock/mockAdapter";
import type { RoutineTemplate } from "../types";

export const SOCIAL_FORMATS: MockFormat[] = [
  { id: "instagram-post", label: "Instagram post", width: 1080, height: 1080 },
  { id: "instagram-portrait", label: "Instagram portrait", width: 1080, height: 1350 },
  { id: "instagram-story", label: "Instagram story", width: 1080, height: 1920 },
  { id: "facebook-post", label: "Facebook post", width: 1200, height: 630 },
  { id: "facebook-cover", label: "Facebook cover", width: 820, height: 312 },
  { id: "linkedin-post", label: "LinkedIn post", width: 1200, height: 627 },
  { id: "linkedin-banner", label: "LinkedIn banner", width: 1584, height: 396 },
  { id: "x-post", label: "X post", width: 1600, height: 900 },
  { id: "x-header", label: "X header", width: 1500, height: 500 },
  { id: "pinterest-pin", label: "Pinterest pin", width: 1000, height: 1500 },
  { id: "youtube-thumbnail", label: "YouTube thumbnail", width: 1280, height: 720 },
  { id: "tiktok-cover", label: "TikTok cover", width: 1080, height: 1920 },
];

// Mock Figma routines. The scripts are illustrative Figma Plugin API code; nothing runs them yet
// (the Doppel Figma plugin and its WebSocket bridge come later).

const socialFormats = `// Doppel routine · Figma Plugin API
const FORMATS = params.formatSizes; // { id: { name, width, height } }
const source = figma.currentPage.findOne((n) => n.type === "FRAME" && n.name === params.sourceFrame);
if (!source) throw new Error("Source frame not found: " + params.sourceFrame);

let x = source.x + source.width + 200;
for (const id of params.formats) {
  const format = FORMATS[id];
  const frame = source.clone();
  frame.name = format.name;
  frame.x = x;
  x += format.width + 100;

  // Scale the frame, then keep the product and headline inside the safe area.
  frame.rescale(Math.min(format.width / source.width, format.height / source.height));
  frame.resizeWithoutConstraints(format.width, format.height);
  for (const node of frame.findAll((n) => n.getPluginData("doppel:role") !== "")) {
    fitToSafeArea(node, frame, 0.06);
  }
  doppel.output({ key: "format-" + id, label: format.name + " " + format.width + "×" + format.height, nodeId: frame.id });
}`;

const renameLayers = `// Doppel routine · Figma Plugin API
const frames = figma.currentPage.selection.length
  ? figma.currentPage.selection
  : figma.currentPage.children.filter((n) => n.type === "FRAME");

for (const frame of frames) {
  let index = 1;
  for (const node of frame.findAll(() => true)) {
    const name = node.name.replace(/^\\d+_/, "");
    node.name = params.pattern
      .replace("{index}", String(index++).padStart(2, "0"))
      .replace("{name}", name)
      .replace("{section}", frame.name);
  }
}
doppel.output({ key: "layers", label: "Renamed layers" });`;

export const FIGMA_TEMPLATES: RoutineTemplate[] = [
  {
    id: "figma-social-formats",
    appId: "figma",
    name: "Social formats from master visual",
    description: "Turns one master visual into every social format, keeping the product and headline in the safe area.",
    keywords: ["resize", "social", "format", "formats", "instagram", "story", "linkedin", "facebook", "campaign", "sizes", "banner", "adapt", "variants"],
    steps: [
      "Duplicate the master visual once per format",
      "Resize each copy to the format's size",
      "Keep the product and headline inside the safe area",
      "Name each frame after its format",
    ],
    params: [
      { key: "sourceFrame", label: "Source frame", type: "select", required: true, default: "Master visual", optionsSource: "frames" },
      {
        key: "formats",
        label: "Formats",
        type: "formatList",
        required: true,
        default: SOCIAL_FORMATS.map((f) => f.id),
        options: SOCIAL_FORMATS.map((f) => ({ value: f.id, label: `${f.label} ${f.width}×${f.height}` })),
      },
      { key: "namingPattern", label: "Frame naming pattern", type: "text", required: true, default: "{format}", help: "Tokens: {client}, {format}" },
    ],
    script: socialFormats,
    modifiesDocument: true,
    qcProfile: "web",
    requiredFonts: ["Inter"],
    naming: { paramKey: "namingPattern", houseStyle: "{client}_{format}_v1" },
  },
  {
    id: "figma-rename-layers",
    appId: "figma",
    name: "Rename and organize layers",
    description: "Renames every layer in the selected frames with a pattern.",
    keywords: ["rename", "layer", "layers", "organize", "naming", "tidy", "clean"],
    steps: ["Go through each selected frame", "Rename every layer with the pattern", "Number layers from top to bottom"],
    params: [{ key: "pattern", label: "Naming pattern", type: "text", required: true, default: "{section}/{name}", help: "Tokens: {section}, {index}, {name}" }],
    script: renameLayers,
    modifiesDocument: true,
    qcProfile: "web",
    requiredFonts: [],
  },
];
