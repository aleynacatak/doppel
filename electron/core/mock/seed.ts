import type { RoutineTemplate } from "../../adapters/types";
import { placeholderPreview } from "../../adapters/previews";
import { SOCIAL_FORMATS } from "../../adapters/figma/templates";
import { FIGMA_TEMPLATES } from "../../adapters/figma/templates";
import { INDESIGN_TEMPLATES } from "../../adapters/indesign/templates";
import type { Storage } from "../services/storage";
import { summarizeRun } from "../services/runService";
import type { ParamValues, QcResult, Routine, Run, RunOutput, StyleProfile } from "../types";
import { newId } from "../util";

/** The template library the mock AI picks from: every prebuilt routine, all apps. */
export const TEMPLATE_LIBRARY: RoutineTemplate[] = [...INDESIGN_TEMPLATES, ...FIGMA_TEMPLATES];

interface SeedPlan {
  templateId: string;
  aiCalls: number;
  appVersion: string;
  runs: { daysAgo: number; params: ParamValues; flagged?: string[]; outputs: () => RunOutput[] }[];
}

const daysAgo = (n: number, hour = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 12, 0, 0);
  return d.toISOString();
};

const pass = (labels: string[] = ["Text fits its frames", "Links are present and up to date", "Fonts are installed", "Images are at least 300 ppi"]): QcResult => ({
  status: "pass",
  checks: [
    ...labels.map((label) => ({ level: "rule" as const, label, passed: true })),
    { level: "object", label: "Key objects stay inside the frame", passed: true },
    { level: "object", label: "Text doesn't overlap images", passed: true },
  ],
});

const pages = (n: number, flagged: Record<number, string> = {}): RunOutput[] =>
  Array.from({ length: n }, (_, i) => {
    const qc = pass();
    if (flagged[i + 1]) {
      qc.status = "flagged";
      qc.checks[0] = { level: "rule", label: "Text fits its frames", passed: false, reason: flagged[i + 1] };
    }
    return {
      id: `page-${i + 1}`,
      label: `Page ${i + 1}`,
      status: "done",
      page: String(i + 1),
      pageIndex: i + 1,
      preview: placeholderPreview(`Page ${i + 1}`, 210, 297),
      qc,
    };
  });

const formats = (flagged: boolean): RunOutput[] =>
  SOCIAL_FORMATS.map((f) => {
    const qc = pass(["Text fits its frames", "Fonts are installed"]);
    if (flagged && f.id === "instagram-story") {
      qc.status = "flagged";
      qc.checks[2] = { level: "object", label: "Key objects stay inside the frame", passed: false, reason: "Product is cut off at the right edge" };
    }
    if (flagged && f.id === "x-header") {
      qc.status = "flagged";
      qc.checks[0] = { level: "rule", label: "Text fits its frames", passed: false, reason: "Text overflows its frame" };
      qc.checks[3] = { level: "object", label: "Text doesn't overlap images", passed: false, reason: "Headline overlaps the product" };
    }
    return {
      id: `format-${f.id}`,
      label: `${f.label} ${f.width}×${f.height}`,
      status: "done",
      profile: "web",
      preview: placeholderPreview(`${f.label}\n${f.width}×${f.height}`, f.width, f.height),
      qc,
    };
  });

const ALL_FORMATS = SOCIAL_FORMATS.map((f) => f.id);

const PLANS: SeedPlan[] = [
  {
    templateId: "indesign-export-png",
    aiCalls: 6,
    appVersion: "21.0",
    runs: [
      { daysAgo: 1, params: { outputFolder: "/Exports/Spring catalogue", resolution: 150, pageRange: "all", namingPattern: "{doc}_{page}" }, outputs: () => pages(8) },
      { daysAgo: 6, params: { outputFolder: "/Exports/Spring catalogue", resolution: 300, pageRange: "1-4", namingPattern: "{doc}_{page}" }, outputs: () => pages(4, { 3: "Text overflows its frame on page 3" }) },
      { daysAgo: 13, params: { outputFolder: "/Exports/Newsletter", resolution: 150, pageRange: "all", namingPattern: "{doc}_{page}" }, outputs: () => pages(6) },
    ],
  },
  {
    templateId: "indesign-export-pdfs",
    aiCalls: 8,
    appVersion: "21.0",
    runs: [
      {
        daysAgo: 2,
        params: { outputFolder: "/Exports/Annual report", printPreset: "[High Quality Print]", webPreset: "[Smallest File Size]", namingPattern: "{doc}_{format}" },
        outputs: () => [
          { id: "pdf-print", label: "Print PDF · [High Quality Print]", status: "done", profile: "print", preview: placeholderPreview("Print PDF", 210, 297), qc: pass() },
          { id: "pdf-web", label: "Web PDF · [Smallest File Size]", status: "done", profile: "web", preview: placeholderPreview("Web PDF", 210, 297), qc: pass(["Text fits its frames", "Links are present and up to date", "Fonts are installed", "Images are at least 150 ppi"]) },
        ],
      },
      {
        daysAgo: 9,
        params: { outputFolder: "/Exports/Annual report", printPreset: "[Press Quality]", webPreset: "[Smallest File Size]", namingPattern: "{doc}_{format}" },
        outputs: () => [
          { id: "pdf-print", label: "Print PDF · [Press Quality]", status: "done", profile: "print", preview: placeholderPreview("Print PDF", 210, 297), qc: pass() },
          { id: "pdf-web", label: "Web PDF · [Smallest File Size]", status: "done", profile: "web", preview: placeholderPreview("Web PDF", 210, 297), qc: pass() },
        ],
      },
    ],
  },
  {
    templateId: "indesign-preflight",
    aiCalls: 5,
    appVersion: "21.0",
    runs: [
      { daysAgo: 3, params: { minPpi: 300 }, outputs: () => pages(6, { 2: "Text overflows its frame on page 2" }) },
      { daysAgo: 11, params: { minPpi: 300 }, outputs: () => pages(6) },
    ],
  },
  {
    templateId: "indesign-rename-layers",
    aiCalls: 4,
    appVersion: "21.0",
    runs: [
      {
        daysAgo: 5,
        params: { pattern: "{index}_{name}", dryRun: false },
        outputs: () => [
          {
            id: "layers",
            label: "Renamed 4 layers",
            status: "done",
            preview: placeholderPreview("Layers", 4, 3),
            details: [
              { label: "Text", value: "01_Text" },
              { label: "Images", value: "02_Images" },
              { label: "Background", value: "03_Background" },
              { label: "Guides", value: "04_Guides" },
            ],
            qc: pass(),
          },
        ],
      },
    ],
  },
  {
    templateId: "indesign-place-text",
    aiCalls: 11,
    appVersion: "21.0",
    runs: [{ daysAgo: 4, params: { textFile: "/Copy/Guide_chapter_2.docx", startPage: 3 }, outputs: () => pages(5) }],
  },
  {
    templateId: "figma-social-formats",
    aiCalls: 9,
    appVersion: "126.2",
    runs: [
      { daysAgo: 1, params: { sourceFrame: "Master visual", formats: ALL_FORMATS, namingPattern: "{format}" }, outputs: () => formats(true) },
      { daysAgo: 4, params: { sourceFrame: "Master visual", formats: ALL_FORMATS, namingPattern: "{format}" }, outputs: () => formats(false) },
      { daysAgo: 8, params: { sourceFrame: "Product hero", formats: ALL_FORMATS, namingPattern: "{format}" }, outputs: () => formats(false) },
      { daysAgo: 15, params: { sourceFrame: "Master visual", formats: ALL_FORMATS, namingPattern: "{format}" }, outputs: () => formats(true) },
      { daysAgo: 22, params: { sourceFrame: "Master visual", formats: ALL_FORMATS, namingPattern: "{format}" }, outputs: () => formats(false) },
    ],
  },
  {
    templateId: "figma-rename-layers",
    aiCalls: 4,
    appVersion: "126.2",
    runs: [
      {
        daysAgo: 7,
        params: { pattern: "{section}/{name}" },
        outputs: () => [
          {
            id: "layers",
            label: "Renamed 7 layers",
            status: "done",
            preview: placeholderPreview("Layers panel", 4, 3),
            details: [
              { label: "Background", value: "Campaign/Background" },
              { label: "Product shot", value: "Campaign/Product shot" },
              { label: "Headline", value: "Campaign/Headline" },
            ],
            qc: pass(["Text fits its frames", "Fonts are installed"]),
          },
        ],
      },
    ],
  },
];

export const SEED_STYLE_PROFILE: StyleProfile = {
  sources: [
    { id: "seed-style-1", name: "Spring_Catalogue_2025.indd", addedAt: daysAgo(30) },
    { id: "seed-style-2", name: "Annual_Report_2025.indd", addedAt: daysAgo(30) },
  ],
  rules: [
    { label: "Body text", value: "10/14 pt" },
    { label: "Headlines", value: "28/32 pt, sentence case" },
    { label: "Grid", value: "12 columns, 5 mm gutter" },
    { label: "Margins", value: "15 mm, 20 mm inside" },
    { label: "Image resolution", value: "300 ppi for print, 150 ppi for web" },
    { label: "Export naming", value: "client_format_v1" },
  ],
};

/** First launch: write the seed routines (with a few past runs) and the style profile. */
export async function seedIfNeeded(storage: Storage) {
  if (await storage.hasMarker("seeded")) return;
  for (const [i, plan] of PLANS.entries()) {
    const t = TEMPLATE_LIBRARY.find((x) => x.id === plan.templateId)!;
    const createdAt = daysAgo(30 - i);
    const routine: Routine = {
      id: newId(),
      name: t.name,
      appId: t.appId,
      description: t.description,
      steps: t.steps.map((s) => ({ id: newId(), plainLanguage: s })),
      params: t.params,
      script: t.script,
      version: 1,
      createdWithAiCalls: plan.aiCalls,
      appVersion: plan.appVersion,
      requiredFonts: t.requiredFonts,
      runs: [],
      createdAt,
      updatedAt: createdAt,
      versions: [{ version: 1, createdAt, aiCalls: plan.aiCalls, note: "Seed routine" }],
      templateId: t.id,
      experimental: t.experimental,
      modifiesDocument: t.modifiesDocument,
      qcProfile: t.qcProfile,
      builtInQc: t.builtInQc,
    };
    for (const r of plan.runs) {
      const startedAt = daysAgo(r.daysAgo, 9 + (r.daysAgo % 7));
      const run: Run = {
        id: newId(),
        routineId: routine.id,
        routineName: routine.name,
        routineVersion: 1,
        appId: routine.appId,
        params: r.params,
        qcMode: "auto",
        options: { target: "copy" },
        status: "succeeded",
        aiCalls: 0,
        outputs: r.outputs(),
        startedAt,
        finishedAt: new Date(new Date(startedAt).getTime() + 40_000).toISOString(),
      };
      await storage.saveRun(run);
      routine.runs.push(summarizeRun(run, routine));
      routine.updatedAt = routine.updatedAt > startedAt ? routine.updatedAt : startedAt;
    }
    await storage.saveRoutine(routine);
  }
  if (!(await storage.getStyleProfile())) await storage.saveStyleProfile(SEED_STYLE_PROFILE);
  await storage.setMarker("seeded");
}
