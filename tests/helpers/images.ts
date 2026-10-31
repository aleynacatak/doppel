import path from "node:path";

/** The smallest file Doppl reads as a picture of its extension (the check before a run looks at image headers). */
export function fakeImage(file: string, width = 1, height = 1): Buffer {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}
