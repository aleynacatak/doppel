import fs from "node:fs/promises";
import zlib from "node:zlib";

// Reads output images for eval checks without Electron: PNG fully (pixels, for transparency checks), JPEG only its
// size. Plain Node, so the checks run the same in the eval runner and in tests.

export interface DecodedImage {
  width: number;
  height: number;
  /** The PNG has an alpha channel (or a transparent palette color). */
  alpha: boolean;
  /** [r, g, b, a], 0–255. Only for PNGs. */
  pixel?: (x: number, y: number) => [number, number, number, number];
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes a non-interlaced PNG (8 or 16 bits per channel; gray, RGB, palette, gray+alpha, RGBA). */
export function decodePng(data: Buffer): DecodedImage {
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Not a PNG file.");
  let width = 0;
  let height = 0;
  let depth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  for (let pos = 8; pos < data.length; ) {
    const length = data.readUInt32BE(pos);
    const type = data.toString("ascii", pos + 4, pos + 8);
    const body = data.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  if (interlace) throw new Error("Interlaced PNGs aren't supported by the eval checks.");
  if (depth !== 8 && depth !== 16) throw new Error(`PNGs with ${depth}-bit channels aren't supported by the eval checks.`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType as 0 | 2 | 3 | 4 | 6];
  if (!channels) throw new Error(`Unknown PNG color type ${colorType}.`);
  const bpp = channels * (depth / 8);
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rows = Buffer.alloc(stride * height);
  for (let y = 0, i = 0; y < height; y++) {
    const filter = raw[i++];
    const row = rows.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      const v = raw[i++];
      row[x] = (filter === 1 ? v + a : filter === 2 ? v + b : filter === 3 ? v + ((a + b) >> 1) : filter === 4 ? v + paeth(a, b, c) : v) & 255;
    }
  }
  const sample = (x: number, y: number, ch: number) => rows[y * stride + (x * channels + ch) * (depth / 8)];
  const pixel = (x: number, y: number): [number, number, number, number] => {
    if (colorType === 3) {
      const idx = sample(x, y, 0);
      const alpha = trns && idx < trns.length ? trns[idx] : 255;
      return [palette![idx * 3], palette![idx * 3 + 1], palette![idx * 3 + 2], alpha];
    }
    if (colorType === 0 || colorType === 4) {
      const g = sample(x, y, 0);
      return [g, g, g, colorType === 4 ? sample(x, y, 1) : 255];
    }
    return [sample(x, y, 0), sample(x, y, 1), sample(x, y, 2), colorType === 6 ? sample(x, y, 3) : 255];
  };
  return { width, height, alpha: colorType === 4 || colorType === 6 || !!trns, pixel };
}

/** The size of a JPEG, from its start-of-frame marker. */
export function jpegSize(data: Buffer): { width: number; height: number } {
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error("Not a JPEG file.");
  for (let pos = 2; pos < data.length; ) {
    if (data[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = data[pos + 1];
    const length = data.readUInt16BE(pos + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: data.readUInt16BE(pos + 5), width: data.readUInt16BE(pos + 7) };
    }
    pos += 2 + length;
  }
  throw new Error("The JPEG has no size marker.");
}

/** PNG (with pixels) or JPEG (size only). */
export async function readImage(file: string): Promise<DecodedImage> {
  const data = await fs.readFile(file);
  if (data.subarray(0, 8).equals(PNG_SIGNATURE)) return decodePng(data);
  if (data[0] === 0xff && data[1] === 0xd8) return { ...jpegSize(data), alpha: false };
  throw new Error("Only PNG and JPEG images can be checked.");
}

/** Encodes RGBA pixels as a PNG (for synthetic fixtures and tests). */
export function encodePng(width: number, height: number, rgba: (x: number, y: number) => [number, number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = rgba(x, y);
      raw.set([r, g, b, a], y * (width * 4 + 1) + 1 + x * 4);
    }
  }
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
