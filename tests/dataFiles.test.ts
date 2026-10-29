import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import writeXlsxFile from "write-excel-file/node";
import {
  DataFileError,
  listFolderFiles,
  readDataFile,
  resolveFileInFolder,
  sniffDelimiter,
} from "../electron/core/helpers/dataFiles";

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-data-"));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function file(name: string, content: string | Buffer): Promise<string> {
  const p = path.join(dir, name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
  return p;
}

async function fileError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(DataFileError);
    return (err as Error).message;
  }
  throw new Error("Expected a DataFileError");
}

describe("readDataFile: CSV", () => {
  it("handles BOM, quotes, commas in quotes, CRLF, blank lines and leading zeros", async () => {
    const p = await file(
      "products.csv",
      '﻿"sku", name ,"price"\r\n"00123","Mug, large","4.50"\r\n\r\n00456,"Say ""hi""",\r\n',
    );
    const table = await readDataFile(p);
    expect(table.fileName).toBe("products.csv");
    expect(table.format).toBe("csv");
    expect(table.columns).toEqual(["sku", "name", "price"]);
    expect(table.rows).toEqual([
      { sku: "00123", name: "Mug, large", price: "4.50" },
      { sku: "00456", name: 'Say "hi"', price: null },
    ]);
    expect(table.errors).toEqual([]);
  });

  it("numbers rows like the file, counting blank lines", async () => {
    const p = await file("required.csv", "sku,price\n001,4\n\n002,\n003,5\n");
    const table = await readDataFile(p, { requiredColumns: ["price"] });
    expect(table.rows).toHaveLength(3);
    expect(table.errors).toEqual([{ row: 3, column: "price", message: '"price" is empty.' }]);
  });

  it("detects semicolons and tabs", async () => {
    const semi = await readDataFile(await file("semi.csv", "name;price\nMug;1,50\nCup;2,00\n"));
    expect(semi.columns).toEqual(["name", "price"]);
    expect(semi.rows[0]).toEqual({ name: "Mug", price: "1,50" });

    const tsv = await readDataFile(await file("tabs.tsv", "name\tprice\nMug\t1,50\n"));
    expect(tsv.rows).toEqual([{ name: "Mug", price: "1,50" }]);

    const txt = await readDataFile(await file("tabs.txt", "name\tprice\nMug, large\t3\n"));
    expect(txt.rows).toEqual([{ name: "Mug, large", price: "3" }]);
  });

  it("reports too few and too many fields with row numbers", async () => {
    const p = await file("fields.csv", "a,b,c\n1,2,3\n4,5\n\n6,7,8,9\n");
    const table = await readDataFile(p);
    expect(table.rows).toEqual([
      { a: "1", b: "2", c: "3" },
      { a: "4", b: "5", c: null },
      { a: "6", b: "7", c: "8" },
    ]);
    expect(table.errors.map((e) => e.row)).toEqual([2, 4]);
    expect(table.errors[0].message).toBe("This row has 2 values, but there are 3 columns. The missing values were left empty.");
    expect(table.errors[1].message).toBe("This row has 4 values, but there are only 3 columns. The extra values were left out.");
  });

  it("ignores a trailing comma on every line", async () => {
    const table = await readDataFile(await file("trailing.csv", "a,b,\n1,2,\n"));
    expect(table.columns).toEqual(["a", "b"]);
    expect(table.errors).toEqual([]);
  });

  it("reports an unclosed quote", async () => {
    const table = await readDataFile(await file("quote.csv", 'a,b\n1,2\n3,"oops\n4,5\n'));
    expect(table.errors).toHaveLength(1);
    expect(table.errors[0].row).toBe(2);
    expect(table.errors[0].message).toMatch(/never closed/);
  });

  it("rejects bad headers and missing required columns", async () => {
    expect(await fileError(readDataFile(await file("dup.csv", "sku,name, sku\n1,2,3\n")))).toBe(
      'dup.csv has more than one column called "sku". Column names must be unique.',
    );
    expect(await fileError(readDataFile(await file("unnamed.csv", "sku,,price\n1,2,3\n")))).toMatch(/Column 2 .* has no name/);
    expect(
      await fileError(readDataFile(await file("missing.csv", "sku,name\n1,2\n"), { requiredColumns: ["sku", "price", "size"] })),
    ).toBe('missing.csv is missing the columns "price" and "size". Check the column names in the first row.');
    expect(await fileError(readDataFile(await file("empty.csv", "\n  \n")))).toBe("empty.csv is empty.");
  });

  it("stops at maxRows", async () => {
    const p = await file("many.csv", "n\n1\n2\n3\n4\n5\n");
    const table = await readDataFile(p, { maxRows: 3 });
    expect(table.rows.map((r) => r.n)).toEqual(["1", "2", "3"]);
    expect(table.errors).toEqual([
      { row: 4, message: "Only the first 3 rows were read. This row and the rest of the file were skipped." },
    ]);
  });

  it("reads Windows-1252 text from older Excel exports", async () => {
    const p = await file("latin.csv", Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x43, 0x61, 0x66, 0xe9, 0x0a]));
    expect((await readDataFile(p)).rows).toEqual([{ name: "Café" }]);
  });
});

describe("readDataFile: whole-file problems", () => {
  it("rejects missing, unsupported and oversized files", async () => {
    expect(await fileError(readDataFile(path.join(dir, "nope.csv")))).toMatch(/^Couldn't find nope.csv/);
    expect(await fileError(readDataFile(await file("old.xls", "x")))).toMatch(/can't read ".xls" files/);
    const big = await file("big.csv", "");
    await fs.truncate(big, 21 * 1024 * 1024);
    expect(await fileError(readDataFile(big))).toMatch(/too large \(21.0 MB\)/);
  });
});

describe("readDataFile: JSON", () => {
  it("reads an array of objects", async () => {
    const p = await file(
      "rows.json",
      JSON.stringify([
        { sku: "001", price: 4.5, active: true },
        { sku: "002", tags: ["a", "b"], price: "" },
        5,
        {},
        { sku: "003", note: null },
      ]),
    );
    const table = await readDataFile(p);
    expect(table.format).toBe("json");
    expect(table.columns).toEqual(["sku", "price", "active", "tags", "note"]);
    expect(table.rows).toEqual([
      { sku: "001", price: 4.5, active: true, tags: null, note: null },
      { sku: "002", price: null, active: null, tags: null, note: null },
      { sku: "003", price: null, active: null, tags: null, note: null },
    ]);
    expect(table.errors).toEqual([
      { row: 2, column: "tags", message: '"tags" holds a list or group of values, which can\'t be used. It was left empty.' },
      { row: 3, message: 'This item isn\'t a row of values (like {"name": "…"}), so it was skipped.' },
    ]);
  });

  it("reads {rows} and {data}, and checks required columns", async () => {
    const rows = await readDataFile(
      await file("wrapped.json", JSON.stringify({ rows: [{ a: 1, b: "x" }, { a: null, b: "y" }, { a: "  " }] })),
      { requiredColumns: ["a"] },
    );
    expect(rows.rows).toEqual([
      { a: 1, b: "x" },
      { a: null, b: "y" },
    ]);
    expect(rows.errors).toEqual([{ row: 2, column: "a", message: '"a" is empty.' }]);

    const data = await readDataFile(await file("data.json", JSON.stringify({ data: [{ b: "x" }] })));
    expect(data.rows).toEqual([{ b: "x" }]);

    expect(await fileError(readDataFile(await file("req.json", "[]"), { requiredColumns: ["sku"] }))).toBe(
      'req.json is missing the column "sku".',
    );
  });

  it("rejects broken or unexpected JSON", async () => {
    expect(await fileError(readDataFile(await file("broken.json", '[{"a": 1,}\n]')))).toMatch(/^broken.json isn't valid JSON/);
    expect(await fileError(readDataFile(await file("object.json", '{"a": 1}')))).toMatch(/should contain a list of rows/);
  });
});

describe("readDataFile: XLSX", () => {
  it("keeps numbers, booleans and dates, and skips empty rows", async () => {
    const p = path.join(dir, "sheet.xlsx");
    await writeXlsxFile(
      [
        ["SKU", " Name ", "Price", "In stock", "Launch", "Note"],
        ["00123", "Mug", 4.5, true, new Date(Date.UTC(2026, 0, 15)), null],
        [null, null, null, null, null, null],
        ["00456", "Cup", 3, false, new Date(Date.UTC(2026, 1, 1, 9, 30)), "hi"],
      ],
      { dateFormat: "yyyy-mm-dd" },
    ).toFile(p);

    const table = await readDataFile(p, { requiredColumns: ["Note"] });
    expect(table.format).toBe("xlsx");
    expect(table.columns).toEqual(["SKU", "Name", "Price", "In stock", "Launch", "Note"]);
    expect(table.rows).toEqual([
      { SKU: "00123", Name: "Mug", Price: 4.5, "In stock": true, Launch: "2026-01-15", Note: null },
      { SKU: "00456", Name: "Cup", Price: 3, "In stock": false, Launch: "2026-02-01T09:30:00.000Z", Note: "hi" },
    ]);
    expect(table.errors).toEqual([{ row: 1, column: "Note", message: '"Note" is empty.' }]);
  });

  it("picks a sheet by name or number", async () => {
    const p = path.join(dir, "sheets.xlsx");
    await writeXlsxFile([
      { sheet: "Products", data: [["name"], ["Mug"]] },
      { sheet: "Prices", data: [["price"], [4]] },
    ]).toFile(p);

    expect((await readDataFile(p)).rows).toEqual([{ name: "Mug" }]);
    expect((await readDataFile(p, { sheet: "prices" })).rows).toEqual([{ price: 4 }]);
    expect((await readDataFile(p, { sheet: 2 })).rows).toEqual([{ price: 4 }]);
    expect(await fileError(readDataFile(p, { sheet: "Stock" }))).toBe(
      'sheets.xlsx doesn\'t have a sheet called "Stock". Its sheets are: Products, Prices.',
    );
  });

  it("rejects duplicate headers and broken files", async () => {
    const p = path.join(dir, "dup.xlsx");
    await writeXlsxFile([["a", "a"], [1, 2]]).toFile(p);
    expect(await fileError(readDataFile(p))).toMatch(/more than one column called "a"/);
    expect(await fileError(readDataFile(await file("fake.xlsx", "not a zip")))).toMatch(/couldn't be opened as an Excel file/);
  });
});

/** Text as an older Turkish Windows program saves it (Windows-1254). */
const TURKISH: Record<string, number> = { Ş: 0xde, ş: 0xfe, Ğ: 0xd0, ğ: 0xf0, İ: 0xdd, ı: 0xfd, Ç: 0xc7, ç: 0xe7, Ö: 0xd6, ö: 0xf6, Ü: 0xdc, ü: 0xfc };
const windows1254 = (text: string) => Buffer.from([...text].map((ch) => TURKISH[ch] ?? ch.charCodeAt(0)));

describe("readDataFile: files from other programs", () => {
  it("reads a Turkish Windows export with semicolons, decimal commas and a comma in a header", async () => {
    const t = await readDataFile(await file("tr-1254.csv", windows1254("Ürün Adı;Fiyat (TL, KDV dahil)\nŞeftali Reçeli;2,5\nIlık İncir;3,0\n")));
    expect(t.columns).toEqual(["Ürün Adı", "Fiyat (TL, KDV dahil)"]);
    expect(t.rows).toEqual([
      { "Ürün Adı": "Şeftali Reçeli", "Fiyat (TL, KDV dahil)": "2,5" },
      { "Ürün Adı": "Ilık İncir", "Fiyat (TL, KDV dahil)": "3,0" },
    ]);
    expect(t.readAs).toEqual({ encoding: "windows-1254", delimiter: ";" });
  });

  it("reads UTF-16 in either byte order, with or without a byte-order mark", async () => {
    const text = "name\tprice\nŞeftali\t2,5\n";
    const le = Buffer.from(text, "utf16le");
    const be = Buffer.from(le).swap16();
    for (const [name, bytes, encoding] of [
      ["le-bom.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), le]), "utf-16le"],
      ["be-bom.txt", Buffer.concat([Buffer.from([0xfe, 0xff]), be]), "utf-16be"],
      ["le.txt", le, "utf-16le"],
      ["be.txt", be, "utf-16be"],
    ] as const) {
      const t = await readDataFile(await file(name, bytes));
      expect([name, t.rows[0], t.readAs?.encoding]).toEqual([name, { name: "Şeftali", price: "2,5" }, encoding]);
    }
  });

  it("reads columns under the names the routine expects, whatever their case or spelling", async () => {
    const t = await readDataFile(await file("headers.csv", "FLAVOR ,urun_adi,Price\nMango,Mango Reçeli,4\n"), { requiredColumns: ["Flavor", "Ürün Adı"] });
    expect(t.columns).toEqual(["Flavor", "Ürün Adı", "Price"]);
    expect(t.rows[0]).toEqual({ Flavor: "Mango", "Ürün Adı": "Mango Reçeli", Price: "4" });
    expect(t.readAs?.renamed).toEqual({ Flavor: "FLAVOR", "Ürün Adı": "urun_adi" });
    const empty = await readDataFile(await file("headers-empty.csv", "flavor\nMango\n\n,\n"), { requiredColumns: ["Flavor"] });
    expect(empty.rows).toEqual([{ Flavor: "Mango" }]);
    expect(await fileError(readDataFile(await file("headers-two.csv", "FLAVOR,flavor\nA,B\n"), { requiredColumns: ["Flavor"] }))).toBe(
      'headers-two.csv has more than one column like "Flavor": "FLAVOR", "flavor". Keep one of them.',
    );
  });

  it("guesses the delimiter whose columns line up", () => {
    expect(sniffDelimiter("Ad;Fiyat (TL, KDV dahil)\nMango;2,5\n")).toBe(";");
    expect(sniffDelimiter("name,note\nFig,sweet; dried\nPlum,tart\n")).toBe(",");
    expect(sniffDelimiter('name,price\n"Fig, dried",2.5\n')).toBe(",");
    expect(sniffDelimiter("a\tb\n1\t2\n")).toBe("\t");
    expect(sniffDelimiter("Flavor\nMango\n")).toBe(",");
  });
});

describe("listFolderFiles", () => {
  let folder: string;

  beforeAll(async () => {
    folder = path.join(dir, "assets");
    for (const name of ["b.CSV", "a.csv", "img10.png", "img2.png", "photo.JPEG", ".DS_Store", "notes.txt", "sub/inner.csv"]) {
      await file(path.join("assets", name), "x");
    }
  });

  it("lists files sorted by name, without dotfiles or folders", async () => {
    const files = await listFolderFiles(folder);
    expect(files.map((f) => f.name)).toEqual(["a.csv", "b.CSV", "img2.png", "img10.png", "notes.txt", "photo.JPEG"]);
    expect(files[1]).toEqual({ name: "b.CSV", path: path.join(folder, "b.CSV"), stem: "b", ext: "csv" });
  });

  it("filters by extension, ignoring case and dots", async () => {
    expect((await listFolderFiles(folder, { extensions: ["csv"] })).map((f) => f.name)).toEqual(["a.csv", "b.CSV"]);
    expect((await listFolderFiles(folder, { extensions: [".PNG"] })).map((f) => f.name)).toEqual(["img2.png", "img10.png"]);
    // JPEG and JPG are one format.
    expect((await listFolderFiles(folder, { extensions: ["jpg", "png"] })).map((f) => f.name)).toEqual(["img2.png", "img10.png", "photo.JPEG"]);
  });

  it("explains a missing folder", async () => {
    expect(await fileError(listFolderFiles(path.join(dir, "gone")))).toMatch(/Couldn't find the folder gone/);
  });
});

describe("resolveFileInFolder", () => {
  let folder: string;

  beforeAll(async () => {
    folder = path.join(dir, "images");
    for (const name of ["Logo.PNG", "logo.svg", "photo.jpg", "Café.jpg"]) {
      await file(path.join("images", name), "x");
    }
  });

  it("finds exact and case-insensitive names", async () => {
    expect(await resolveFileInFolder(folder, "photo.jpg")).toBe(path.join(folder, "photo.jpg"));
    expect(await resolveFileInFolder(folder, " PHOTO.JPG ")).toBe(path.join(folder, "photo.jpg"));
    expect(await resolveFileInFolder(folder, "Café.jpg")).toBe(path.join(folder, "Café.jpg"));
  });

  it("finds a file by stem, in extension order", async () => {
    expect(await resolveFileInFolder(folder, "logo", { extensions: ["svg", "png"] })).toBe(path.join(folder, "logo.svg"));
    expect(await resolveFileInFolder(folder, "logo", { extensions: ["png", "svg"] })).toBe(path.join(folder, "Logo.PNG"));
    expect(await resolveFileInFolder(folder, "photo", { extensions: ["png"] })).toBeNull();
  });

  it("rejects paths and returns null for missing files", async () => {
    for (const name of ["../photo.jpg", "sub/photo.jpg", "sub\\photo.jpg", "..", ""]) {
      expect(await resolveFileInFolder(folder, name)).toBeNull();
    }
    expect(await resolveFileInFolder(folder, "nope.jpg")).toBeNull();
  });
});
