import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { preflight } from "../electron/core/inputs/preflight";
import { inputNodeId, routineFlow } from "../electron/core/services/flowService";
import type { FlowRoutines } from "../electron/core/flows/validateFlow";
import type { MatchRule, Routine } from "../electron/core/types";

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
  for (const f of ["strawberryvanilla.png", "Mango-label.JPEG", "extra.png", "notes.txt"]) await fs.writeFile(path.join(dir, "pics", f), "x");
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
      },
    ]);
    expect(report.skipped.map((n) => n.text)).toEqual(["pics: notes.txt isn't PNG or JPG, so it isn't used."]);
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
    expect(report.fixed[0]).toEqual({ text: "Matched “Ürün Adı” in jams.csv to “Flavor” with AI", change: { inputNodeId: "input-jams", column: "Flavor", candidates: ["Fiyat", "Ürün Adı"] } });
    expect(report.fixed.map((n) => n.text)).toContain("Matched 1 picture by name despite different spelling: strawberryvanilla.png → Strawberry Vanilla");
    // Kept: the next check uses it without AI.
    const again = await preflight(routineFlow(routine), info, inputs, report.columns, { matchColumns });
    expect(asked).toHaveLength(1);
    expect(again.fixed[0].text).toBe("Used “Ürün Adı” for “Flavor” in jams.csv, as you picked");
    // What the AI can't place, the designer picks.
    const none = await preflight(routineFlow(routine), info, inputs, {}, { matchColumns: async () => ({ Flavor: null }) });
    expect(none.needs.map((i) => i.kind)).toEqual(["column"]);
  });

  it("explains a file it can't read, and items that will be made without a partner when that's set", async () => {
    const broken = await check("");
    expect(broken.needs).toEqual([{ kind: "file", id: "file:input-jams", inputNodeId: "input-jams", text: "jams.csv is empty." }]);
    const optional = await check("Flavor\nFig\nMango\n", { pictures: { ...rule, optional: true } });
    expect(optional.needs).toEqual([]);
    expect(optional.fixed.map((n) => n.text)).toContain("Fig will be made without a picture, as set");
  });
});
