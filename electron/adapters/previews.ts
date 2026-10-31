import { nativeImage } from "electron";
import path from "node:path";
import type { PreviewImage } from "../core/types";

const MAX_PREVIEW = 640;
const SQUARE = 16;
const DARK = [0x40, 0x40, 0x40];
const LIGHT = [0x52, 0x52, 0x52];

/**
 * An image with transparent areas on a dark gray checkerboard, or null when it has none. A JPEG can't keep
 * transparency; on the checkerboard it stays visible, and so do white specks or a white fringe left from a background.
 */
function onCheckerboard(image: Electron.NativeImage): Electron.NativeImage | null {
  const { width, height } = image.getSize();
  const src = image.toBitmap();
  if (src.length !== width * height * 4) return null;
  let transparent = false;
  for (let i = 3; i < src.length && !transparent; i += 4) transparent = src[i] < 255;
  if (!transparent) return null;
  // Bitmaps are usually premultiplied (no color above its alpha); otherwise colors are scaled by alpha here.
  let premultiplied = true;
  for (let i = 0; i < src.length && premultiplied; i += 4) premultiplied = src[i] <= src[i + 3] && src[i + 1] <= src[i + 3] && src[i + 2] <= src[i + 3];
  const out = Buffer.alloc(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = src[i + 3] / 255;
      const bg = (Math.floor(x / SQUARE) + Math.floor(y / SQUARE)) % 2 ? LIGHT : DARK;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round((premultiplied ? src[i + c] : src[i + c] * a) + bg[2 - c] * (1 - a));
      out[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(out, { width, height });
}

function toPreview(image: Electron.NativeImage, label: string, max = MAX_PREVIEW): PreviewImage | undefined {
  if (image.isEmpty()) return undefined;
  const { width, height } = image.getSize();
  if (width > max || height > max) image = image.resize(width >= height ? { width: max, quality: "good" } : { height: max, quality: "good" });
  const size = image.getSize();
  const flat = onCheckerboard(image);
  return {
    kind: "image",
    src: `data:image/jpeg;base64,${(flat ?? image).toJPEG(80).toString("base64")}`,
    width: size.width,
    height: size.height,
    label,
    ...(flat ? { transparent: true } : {}),
  };
}

const quickLook = (filePath: string) => nativeImage.createThumbnailFromPath(filePath, { width: MAX_PREVIEW, height: MAX_PREVIEW });

/**
 * Preview of a file on disk: PNG and JPEG are downscaled; PDFs, SVGs and what Electron can't read itself (PSD, TIFF,
 * WebP…) use the macOS Quick Look thumbnail.
 */
export async function filePreview(filePath: string, label = path.basename(filePath), max = MAX_PREVIEW): Promise<PreviewImage | undefined> {
  const ext = path.extname(filePath).toLowerCase();
  let image = ext === ".pdf" || ext === ".svg" ? await quickLook(filePath) : nativeImage.createFromPath(filePath);
  if (image.isEmpty() && ext !== ".pdf" && ext !== ".svg") image = await quickLook(filePath).catch(() => image);
  return toPreview(image, label, max);
}

/** Small pictures of files the designer picked (to choose one by its picture), by path; files that aren't images are left out. */
export async function filePreviews(paths: string[], max = 160): Promise<Record<string, PreviewImage>> {
  const out: Record<string, PreviewImage> = {};
  for (const p of paths.slice(0, 40)) {
    if (!/\.(png|jpe?g|gif|webp|tiff?|psd|psb|heic|bmp)$/i.test(p)) continue;
    const preview = await filePreview(p, path.basename(p), max).catch(() => undefined);
    if (preview) out[p] = preview;
  }
  return out;
}

/** Preview of image bytes (PNG/JPEG), e.g. a Figma frame export. */
export function bufferPreview(bytes: Buffer, label: string): PreviewImage | undefined {
  return toPreview(nativeImage.createFromBuffer(bytes), label);
}
