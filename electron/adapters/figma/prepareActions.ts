import fs from "node:fs/promises";
import path from "node:path";
import { BarcodeError, type BarcodeType, barcodeSvg, validateBarcode } from "../../core/helpers/barcode";
import { DataFileError, resolveFileInFolder } from "../../core/helpers/dataFiles";
import type { RuleFinding } from "../../core/types";

// Turns an expanded action list into what the plugin receives: images and SVG files are read into the message,
// barcodes are drawn as SVG, export folders are checked. Problems with the item's data (a missing image, a wrong
// check digit) fail only that item and become quality-check findings.

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif"];
const MAX_IMAGE_PX = 4096;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

/** A problem with the current item's data; the stage goes on with the next item. */
export class ItemDataError extends Error {
  constructor(
    message: string,
    readonly finding?: RuleFinding,
  ) {
    super(message);
    this.name = "ItemDataError";
  }
}

/** Width and height from a PNG, JPEG or GIF header (null if unknown). */
export function imageSize(bytes: Buffer): { width: number; height: number; type: "png" | "jpeg" | "gif" } | null {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), type: "png" };
  }
  if (bytes.length > 10 && bytes.toString("ascii", 0, 3) === "GIF") {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), type: "gif" };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      const length = bytes.readUInt16BE(i + 2);
      // SOF markers (C0–CF except C4, C8, CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7), type: "jpeg" };
      }
      i += 2 + length;
    }
    return null;
  }
  return null;
}

async function readImage(filePath: string): Promise<{ bytes: string; name: string }> {
  const name = path.basename(filePath);
  if (!IMAGE_EXTENSIONS.includes(path.extname(filePath).slice(1).toLowerCase())) {
    throw new ItemDataError(`${name} isn't a PNG, JPEG or GIF; Figma can only place those.`);
  }
  let bytes: Buffer;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_IMAGE_BYTES) throw new ItemDataError(`${name} is larger than 40 MB.`);
    bytes = await fs.readFile(filePath);
  } catch (err) {
    if (err instanceof ItemDataError) throw err;
    throw new ItemDataError(`Image not found: ${name}`, { type: "file-missing", message: `Image not found: ${name}` });
  }
  const size = imageSize(bytes);
  if (!size) throw new ItemDataError(`${name} isn't a readable PNG, JPEG or GIF.`);
  if (size.width > MAX_IMAGE_PX || size.height > MAX_IMAGE_PX) {
    throw new ItemDataError(`${name} is ${size.width}×${size.height} px; Figma accepts images up to ${MAX_IMAGE_PX} px.`);
  }
  return { bytes: bytes.toString("base64"), name };
}

function insideAny(target: string, folders: string[]) {
  const t = path.resolve(target);
  return folders.some((f) => {
    const root = path.resolve(f);
    return t === root || t.startsWith(root + path.sep);
  });
}

export interface PreparedActions {
  actions: Record<string, unknown>[];
  /** Barcodes drawn for this item (value as encoded), for the dev panel and logs. */
  barcodes: string[];
}

export async function prepareActions(actions: Record<string, unknown>[], allowedFolders: string[]): Promise<PreparedActions> {
  const out: Record<string, unknown>[] = [];
  const barcodes: string[] = [];
  for (const [i, raw] of actions.entries()) {
    const a = { ...raw };
    const where = `Action ${i + 1} (${String(a.action)})`;
    if (a.action === "setImageFill") {
      const image = a.image as { file?: string; folder?: string; name?: string } | undefined;
      if (image?.file) {
        a.image = await readImage(String(image.file));
      } else if (image?.folder && image.name !== undefined) {
        let found: string | null;
        try {
          found = await resolveFileInFolder(String(image.folder), String(image.name), { extensions: IMAGE_EXTENSIONS });
        } catch (err) {
          throw new ItemDataError(err instanceof DataFileError ? err.message : `${where}: the image folder can't be read.`);
        }
        if (!found) {
          const message = `Image "${image.name}" isn't in ${path.basename(String(image.folder))}`;
          throw new ItemDataError(message, { type: "file-missing", message });
        }
        a.image = await readImage(found);
      } else {
        throw new ItemDataError(`${where}: no image given.`);
      }
    } else if (a.action === "placeSvg") {
      const svg = a.svg as string | { file?: string; barcode?: { type: BarcodeType; value: string | number; showText?: boolean } };
      if (typeof svg === "object" && svg?.barcode) {
        const check = validateBarcode(svg.barcode.type, svg.barcode.value);
        if (!check.ok) {
          const message = `Barcode ${String(svg.barcode.value)}: ${check.message}`;
          throw new ItemDataError(message, { type: "barcode-invalid", message });
        }
        try {
          a.svg = barcodeSvg(svg.barcode.type, check.value, { showText: svg.barcode.showText !== false }).svg;
        } catch (err) {
          const message = err instanceof BarcodeError ? err.message : String(err);
          throw new ItemDataError(message, { type: "barcode-invalid", message });
        }
        barcodes.push(`${svg.barcode.type}:${check.value}`);
      } else if (typeof svg === "object" && svg?.file) {
        const name = path.basename(String(svg.file));
        if (path.extname(name).toLowerCase() !== ".svg") throw new ItemDataError(`${name} isn't an SVG file.`);
        try {
          a.svg = await fs.readFile(String(svg.file), "utf8");
        } catch {
          throw new ItemDataError(`SVG not found: ${name}`, { type: "file-missing", message: `SVG not found: ${name}` });
        }
      } else if (typeof svg !== "string" || !svg.trim().startsWith("<")) {
        throw new ItemDataError(`${where}: the SVG is empty.`);
      }
    } else if (a.action === "exportNode" && typeof a.folder === "string" && !insideAny(a.folder, allowedFolders)) {
      throw new ItemDataError(`${where}: exports can only go into folders picked for this run.`);
    }
    out.push(a);
  }
  return { actions: out, barcodes };
}
