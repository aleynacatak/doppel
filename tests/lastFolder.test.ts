import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { pickerStart, rememberPick } from "../electron/core/services/lastFolder";
import { JsonStorage } from "../electron/core/services/storage";

let dir: string;
let storage: JsonStorage;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-last-folder-"));
  storage = new JsonStorage(path.join(dir, "data"));
  await fs.mkdir(path.join(dir, "jams"));
});

describe("where pickers open", () => {
  it("leaves it to macOS until something was picked", async () => {
    expect(await pickerStart(storage)).toBeUndefined();
  });

  it("opens in a picked folder, and in the folder of picked files", async () => {
    const jams = path.join(dir, "jams");
    await rememberPick(storage, [jams]);
    expect(await pickerStart(storage)).toBe(jams);

    await fs.writeFile(path.join(dir, "products.csv"), "name\nFig\n");
    await rememberPick(storage, [path.join(dir, "products.csv")]);
    expect(await pickerStart(storage)).toBe(dir);
  });

  it("keeps the folder when nothing was picked", async () => {
    await rememberPick(storage, [dir]);
    await rememberPick(storage, []);
    expect(await pickerStart(storage)).toBe(dir);
  });

  it("is remembered after Doppl is closed, and forgotten when the folder is gone", async () => {
    const jams = path.join(dir, "jams");
    await rememberPick(storage, [jams]);
    const reopened = new JsonStorage(path.join(dir, "data"));
    expect(await pickerStart(reopened)).toBe(jams);

    await fs.rm(jams, { recursive: true });
    expect(await pickerStart(reopened)).toBeUndefined();
  });
});
