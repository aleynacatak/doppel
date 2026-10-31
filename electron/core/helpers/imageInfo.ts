import fs from "node:fs/promises";
import path from "node:path";

// What the first bytes of an image file say: its real format, its size in pixels and whether it's CMYK. The check
// before a run uses it to catch a file that isn't the picture its name says (a text file named .png), and to mention
// CMYK and very large images. Only the headers are read, never the pixels.

export interface ImageInfo {
  format: "jpeg" | "png" | "psd" | "tiff" | "gif" | "webp";
  width?: number;
  height?: number;
  cmyk?: boolean;
}

/** Extensions whose files Doppl can check; other files (PDF, SVG, AI, HEIC…) aren't looked into. */
const CHECKED = new Set(["jpg", "jpeg", "jpe", "png", "psd", "psb", "tif", "tiff", "gif", "webp"]);

/** Images at or over this many pixels are slow to work on and make big files (10000 × 10000 makes a 130 MB PNG). */
export const LARGE_PIXELS = 50_000_000;

export const isCheckedImage = (file: string) => CHECKED.has(path.extname(file).slice(1).toLowerCase());

async function readAt(handle: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/** JPEG: walks the segments to the frame header (an ICC profile before it can be hundreds of KB). */
async function jpegInfo(handle: fs.FileHandle): Promise<ImageInfo> {
  let at = 2;
  for (let i = 0; i < 500; i++) {
    const head = await readAt(handle, at, 4);
    if (head.length < 4 || head[0] !== 0xff) break;
    const marker = head[1];
    // Fill bytes and markers without a length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = head.readUInt16BE(2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const frame = await readAt(handle, at + 4, 6);
      if (frame.length < 6) break;
      return { format: "jpeg", height: frame.readUInt16BE(1), width: frame.readUInt16BE(3), cmyk: frame[5] === 4 };
    }
    at += 2 + length;
  }
  return { format: "jpeg" };
}

/** TIFF: the first image's width, height and photometric interpretation (5 is CMYK). */
async function tiffInfo(handle: fs.FileHandle, little: boolean): Promise<ImageInfo> {
  const u16 = (b: Buffer, o: number) => (little ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b: Buffer, o: number) => (little ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const head = await readAt(handle, 4, 4);
  if (head.length < 4) return { format: "tiff" };
  const ifd = u32(head, 0);
  const count = await readAt(handle, ifd, 2);
  if (count.length < 2) return { format: "tiff" };
  const n = Math.min(u16(count, 0), 200);
  const entries = await readAt(handle, ifd + 2, n * 12);
  const info: ImageInfo = { format: "tiff" };
  for (let i = 0; i + 12 <= entries.length; i += 12) {
    const tag = u16(entries, i);
    const value = u16(entries, i + 2) === 3 ? u16(entries, i + 8) : u32(entries, i + 8);
    if (tag === 256) info.width = value;
    else if (tag === 257) info.height = value;
    else if (tag === 262) info.cmyk = value === 5;
  }
  return info;
}

/**
 * What a file holds, read from its header. `null` when it's none of the image formats Doppl knows (an empty file,
 * text, a broken download); a picture in another format than its extension says is still a picture. `undefined` when
 * the file can't be opened (that's reported where it's read).
 */
export async function readImageInfo(file: string): Promise<ImageInfo | null | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const b = await readAt(handle, 0, 32);
    if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return { format: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return await jpegInfo(handle);
    if (b.length >= 26 && b.toString("latin1", 0, 4) === "8BPS") return { format: "psd", height: b.readUInt32BE(14), width: b.readUInt32BE(18), cmyk: b.readUInt16BE(24) === 4 };
    if (b.length >= 8 && b.toString("latin1", 0, 4) === "II*\0") return await tiffInfo(handle, true);
    if (b.length >= 8 && b.toString("latin1", 0, 4) === "MM\0*") return await tiffInfo(handle, false);
    if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString("latin1", 0, 6))) return { format: "gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return { format: "webp" };
    return null;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The images among `files` that aren't readable, with why (other files and readable ones are left out). */
export async function unreadableImages(files: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const checked = files.filter(isCheckedImage);
  for (let i = 0; i < checked.length; i += 32) {
    const batch = checked.slice(i, i + 32);
    const infos = await Promise.all(batch.map(readImageInfo));
    batch.forEach((f, k) => {
      if (infos[k] === null) out.set(f, `${path.basename(f)} isn't a readable image: it doesn't hold a picture. Replace it with the original file.`);
    });
  }
  return out;
}
