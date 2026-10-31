import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { namelessFile, preflight, suggestPartners } from "../electron/core/inputs/preflight";
import { inputNodeId, routineFlow } from "../electron/core/services/flowService";
import type { FlowRoutines } from "../electron/core/flows/validateFlow";
import type { Flow, MatchRule, Routine } from "../electron/core/types";
import { fakeImage } from "./helpers/images";

// The check before a run, on a messy export: a Turkish Windows CSV with semicolons and an uppercase header, and a
// folder of pictures named loosely, with one missing, one extra and a text file.

const TURKISH: Record<string, number> = { Ş: 0xde, ş: 0xfe, Ğ: 0xd0, ğ: 0xf0, İ: 0xdd, ı: 0xfd, Ç: 0xc7, ç: 0xe7, Ö: 0xd6, ö: 0xf6, Ü: 0xdc, ü: 0xfc };
const windows1254 = (text: string) => Buffer.from([...text].map((ch) => TURKISH[ch] ?? ch.charCodeAt(0)));

const rule: MatchRule = { by: "fileNameEqualsColumn", column: "Flavor", ignoreExtension: true, loose: true };
const routine = {
  id: "r1",
  name: "Jam labels",
  appId: "photoshop",
  kind: "script",
  script: "",
  version: 1,
  inputs: [
    { key: "jams", label: "Jams", type: "rows", required: true, columns: ["Flavor"] },
    { key: "pictures", label: "Pictures", type: "fileList", required: true, extensions: ["png", "jpg"] },
  ],
  iterate: { input: "jams" },
  outputs: [{ key: "labels", label: "Labels", type: "fileList", required: true, extensions: ["png"] }],
  settings: [],
  matches: { pictures: rule },
} as unknown as Routine;
const info: FlowRoutines = { routines: { routine }, stageKind: () => "script" };

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-preflight-"));
  await fs.mkdir(path.join(dir, "pics"));
  for (const f of ["strawberryvanilla.png", "Mango-label.JPEG", "extra.png", "notes.txt"]) await fs.writeFile(path.join(dir, "pics", f), fakeImage(f));
});

const check = (csv: Buffer | string, matches: Record<string, MatchRule> = {}, columns: Record<string, Record<string, string>> = {}) =>
  fs
    .writeFile(path.join(dir, "jams.csv"), csv)
    .then(() =>
      preflight(routineFlow(routine, matches), info, { [inputNodeId("jams")]: path.join(dir, "jams.csv"), [inputNodeId("pictures")]: path.join(dir, "pics") }, columns),
    );

describe("the check before a run", () => {
  it("says what it handled, what needs the designer, and what's skipped", async () => {
    const report = await check(windows1254("FLAVOR;Fiyat (TL, KDV dahil)\nStrawberry Vanilla;4,5\nİncir Fig;5,0\nMango;3,2\n"));
    expect(report.fixed.map((n) => n.text)).toEqual([
      "Read jams.csv as Turkish (Windows)",
      "jams.csv separates its columns with semicolons",
      "Read the column “FLAVOR” in jams.csv as “Flavor”",
      "Matched 2 pictures by name despite different spelling: strawberryvanilla.png → Strawberry Vanilla, Mango-label.JPEG → Mango",
    ]);
    expect(report.needs).toEqual([
      {
        kind: "partner",
        id: "partner:routine:pictures:incir fig",
        nodeId: "routine",
        port: "pictures",
        item: "İncir Fig",
        key: "incir fig",
        text: "No picture found for İncir Fig.",
        candidates: ["extra.png"],
        // Where each one is, for its picture.
        files: { "extra.png": path.join(dir, "pics", "extra.png") },
      },
    ]);
    expect(report.skipped.map((n) => n.text)).toEqual(["pics: notes.txt isn't PNG or JPG, so it isn't used."]);
  });

  it("runs rows with empty cells, and says which are made without that value", async () => {
    const withAllergens = { ...routine, inputs: routine.inputs.map((p) => (p.key === "jams" ? { ...p, columns: ["Flavor", "Allergens"] } : p)) } as Routine;
    await fs.writeFile(path.join(dir, "jams.csv"), "Flavor,Allergens\nStrawberry Vanilla,\nMango,\nİncir Fig,nuts\n");
    const inputs = { [inputNodeId("jams")]: path.join(dir, "jams.csv"), [inputNodeId("pictures")]: path.join(dir, "pics") };
    const report = await preflight(routineFlow(withAllergens), { routines: { routine: withAllergens }, stageKind: () => "script" }, inputs);
    expect(report.fixed.map((n) => n.text)).toContain("2 rows have no “Allergens” in jams.csv: Strawberry Vanilla and Mango are made without it.");
    expect(report.skipped.map((n) => n.text).join(" ")).not.toContain("empty");
  });

  it("uses the pictures and columns the designer picked", async () => {
    const picked = { pictures: { ...rule, pairs: { "incir fig": "extra.png" } } };
    const report = await check("Tat,Price\nStrawberry Vanilla,4\nİncir Fig,5\n", picked);
    expect(report.needs).toEqual([
      { kind: "column", id: "column:input-jams:Flavor", inputNodeId: "input-jams", column: "Flavor", text: "jams.csv has no column “Flavor”. Which column holds it?", candidates: ["Price", "Tat"] },
    ]);
    const again = await check("Tat,Price\nStrawberry Vanilla,4\nİncir Fig,5\n", picked, { "input-jams": { Flavor: "Tat" } });
    expect(again.needs).toEqual([]);
    expect(again.fixed.map((n) => n.text)).toEqual([
      "Used “Tat” for “Flavor” in jams.csv, as you picked",
      "Used the picture you picked for Pictures",
      "Matched 1 picture by name despite different spelling: strawberryvanilla.png → Strawberry Vanilla",
    ]);
  });

  it("matches a column the rules can't find with AI, and keeps it", async () => {
    await fs.writeFile(path.join(dir, "jams.csv"), "Ürün Adı,Fiyat\nStrawberry Vanilla,4\n");
    const asked: unknown[] = [];
    const matchColumns = async (input: { expected: string[]; columns: string[] }) => {
      asked.push(input);
      return { Flavor: "Ürün Adı" };
    };
    const inputs = { [inputNodeId("jams")]: path.join(dir, "jams.csv"), [inputNodeId("pictures")]: path.join(dir, "pics") };
    const report = await preflight(routineFlow(routine), info, inputs, {}, { matchColumns });
    expect(asked).toEqual([expect.objectContaining({ expected: ["Flavor"], columns: ["Ürün Adı", "Fiyat"] })]);
    expect(report.needs).toEqual([]);
    expect(report.columns).toEqual({ "input-jams": { Flavor: "Ürün Adı" } });
    expect(report.aiCalls).toBe(1);
    expect(report.fixed[0]).toEqual({ text: "Matched “Ürün Adı” in jams.csv to “Flavor” with AI", change: { inputNodeId: "input-jams", column: "Flavor", candidates: ["Fiyat", "Ürün Adı"] } });
    expect(report.fixed.map((n) => n.text)).toContain("Matched 1 picture by name despite different spelling: strawberryvanilla.png → Strawberry Vanilla");
    // Kept: the next check uses it without AI.
    const again = await preflight(routineFlow(routine), info, inputs, report.columns, { matchColumns });
    expect(asked).toHaveLength(1);
    expect(again.fixed[0].text).toBe("Used “Ürün Adı” for “Flavor” in jams.csv, as you picked");
    expect(again.aiCalls).toBeUndefined();
    // The screen says which it matched with AI: the note stays (and can still be changed).
    const told = await preflight(routineFlow(routine), info, inputs, report.columns, { matchColumns, aiColumns: report.columns });
    expect(told.fixed[0]).toEqual(report.fixed[0]);
    // Another form of the same word needs no AI.
    await fs.writeFile(path.join(dir, "jams.csv"), "Flavors,Fiyat\nStrawberry Vanilla,4\n");
    const forms = await preflight(routineFlow(routine), info, inputs, {}, { matchColumns });
    expect(asked).toHaveLength(1);
    expect(forms.needs).toEqual([]);
    expect(forms.fixed[0].text).toBe("Read the column “Flavors” in jams.csv as “Flavor”");
    // What the AI can't place, the designer picks.
    await fs.writeFile(path.join(dir, "jams.csv"), "Ürün Adı,Fiyat\nStrawberry Vanilla,4\n");
    const none = await preflight(routineFlow(routine), info, inputs, {}, { matchColumns: async () => ({ Flavor: null }) });
    expect(none.needs.map((i) => i.kind)).toEqual(["column"]);
  });

  it("suggests files with AI for items without one when asked, and uses only what the designer approves", async () => {
    for (const f of ["dried-figs-2.png", "IMG_4032.jpg"]) await fs.writeFile(path.join(dir, "pics", f), fakeImage(f));
    const report = await check("Flavor\nStrawberry Vanilla\nİncir Fig\nKiwi\n");
    expect(report.needs.map((i) => i.id)).toEqual(["partner:routine:pictures:incir fig", "partner:routine:pictures:kiwi"]);
    const asked: unknown[] = [];
    // The AI gives one file to two items and names a file that isn't there: neither is suggested.
    const match = async (input: { items: string[]; files: string[] }) => {
      asked.push(input);
      return { "İncir Fig": "dried-figs-2.png", Kiwi: "dried-figs-2.png", Mango: "nope.png" };
    };
    const suggested = await suggestPartners(routineFlow(routine), info, report.needs, match);
    expect(asked).toEqual([expect.objectContaining({ what: "Pictures", items: ["İncir Fig", "Kiwi"] })]);
    expect((asked[0] as { files: string[] }).files.sort()).toEqual(["IMG_4032.jpg", "Mango-label.JPEG", "dried-figs-2.png", "extra.png"]);
    expect(suggested).toEqual({ "partner:routine:pictures:incir fig": "dried-figs-2.png" });
    // A name that says nothing goes with its picture.
    expect((asked[0] as { pictures?: unknown }).pictures).toEqual([{ name: "IMG_4032.jpg", path: path.join(dir, "pics", "IMG_4032.jpg") }]);
    // Approved, it's a hand pick: the next check uses it without AI.
    const again = await check("Flavor\nStrawberry Vanilla\nİncir Fig\nKiwi\n", { pictures: { ...rule, pairs: { "incir fig": "dried-figs-2.png" } } });
    expect(again.needs.map((i) => i.id)).toEqual(["partner:routine:pictures:kiwi"]);
    expect(again.fixed.map((n) => n.text)).toContain("Used the picture you picked for Pictures");
  });

  it("tells names that say nothing", () => {
    for (const name of ["IMG_4032.jpg", "DSC00012.JPG", "Photo 2024-10-01 at 10.32.png", "Screenshot 2024-10-01.png", "PXL_20241001_103200.jpg"]) expect(namelessFile(name)).toBe(true);
    for (const name of ["pearcaramelsalt.png", "fig-and-walnut v2.png", "Mango-label.JPEG"]) expect(namelessFile(name)).toBe(false);
  });

  it("guesses the files an earlier step makes from the photos it's made from", async () => {
    await fs.writeFile(path.join(dir, "pics", "pearcaramelsalt.jpg"), fakeImage("pearcaramelsalt.jpg"));
    await fs.writeFile(path.join(dir, "jams.csv"), "Flavor\nStrawberry Vanilla\nSalted Caramel Pear\nKiwi\n");
    const cutouts = { ...routine, id: "cut", name: "Cut out photos", inputs: [{ key: "photos", label: "Photos", type: "fileList", required: true }], iterate: { input: "photos" }, outputs: [{ key: "cutouts", label: "Cutouts", type: "fileList", required: true }], matches: {} } as unknown as Routine;
    const labels = { ...routine, inputs: [routine.inputs[0], { key: "cutouts", label: "Cutouts", type: "fileList", required: true }] } as unknown as Routine;
    const flow = {
      nodes: [
        { id: "photos", kind: "input", port: { key: "photos", label: "Product photos", type: "fileList", required: true }, position: { x: 0, y: 0 } },
        { id: "jams", kind: "input", port: { key: "jams", label: "Jams", type: "rows", required: true }, position: { x: 0, y: 0 } },
        { id: "cut", kind: "routine", routineId: "cut", routineVersion: 1, position: { x: 0, y: 0 } },
        { id: "labels", kind: "routine", routineId: "r1", routineVersion: 1, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: "e1", from: { nodeId: "photos", port: "photos" }, to: { nodeId: "cut", port: "photos" } },
        { id: "e2", from: { nodeId: "jams", port: "jams" }, to: { nodeId: "labels", port: "jams" } },
        { id: "e3", from: { nodeId: "cut", port: "cutouts" }, to: { nodeId: "labels", port: "cutouts" }, match: rule },
      ],
    } as unknown as Flow;
    const report = await preflight(flow, { routines: { cut: cutouts, labels }, stageKind: () => "script" }, { photos: path.join(dir, "pics"), jams: path.join(dir, "jams.csv") });
    // Strawberry Vanilla and the reordered pear are matched by their photos' names; Kiwi has none.
    expect(report.needs).toEqual([
      expect.objectContaining({ id: "partner:labels:cutouts:kiwi", text: "No cutout found for Kiwi: no product photo has its name.", files: expect.objectContaining({ "extra.png": path.join(dir, "pics", "extra.png") }) }),
    ]);
  });

  it("explains a file it can't read, and items that will be made without a partner when that's set", async () => {
    const broken = await check("");
    expect(broken.needs).toEqual([{ kind: "file", id: "file:input-jams", inputNodeId: "input-jams", text: "jams.csv is empty." }]);
    const optional = await check("Flavor\nFig\nMango\n", { pictures: { ...rule, optional: true } });
    expect(optional.needs).toEqual([]);
    expect(optional.fixed.map((n) => n.text)).toContain("Fig will be made without a picture, as set");
  });
});
