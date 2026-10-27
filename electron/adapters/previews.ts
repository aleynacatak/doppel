import { nativeImage } from "electron";
import path from "node:path";
import type { PreviewImage } from "../core/types";

const MAX_PREVIEW = 640;

/** Preview of a file on disk: images are downscaled, PDFs use the macOS Quick Look thumbnail. */
export async function filePreview(filePath: string, label = path.basename(filePath)): Promise<PreviewImage> {
  const ext = path.extname(filePath).toLowerCase();
  let image: Electron.NativeImage;
  if (ext === ".pdf") {
    image = await nativeImage.createThumbnailFromPath(filePath, { width: MAX_PREVIEW, height: MAX_PREVIEW });
  } else {
    image = nativeImage.createFromPath(filePath);
  }
  if (image.isEmpty()) return placeholderPreview(label, 4, 3);
  const size = image.getSize();
  if (size.width > MAX_PREVIEW) image = image.resize({ width: MAX_PREVIEW, quality: "good" });
  const final = image.getSize();
  return {
    kind: "image",
    src: `data:image/jpeg;base64,${image.toJPEG(80).toString("base64")}`,
    width: final.width,
    height: final.height,
    label,
  };
}

/** Gray box with a label, in the given aspect ratio (mock previews). */
export function placeholderPreview(label: string, width: number, height: number): PreviewImage {
  const w = 400;
  const h = Math.max(60, Math.round((w * height) / width));
  const lines = label.split("\n");
  const text = lines
    .map(
      (line, i) =>
        `<text x="50%" y="${h / 2 + (i - (lines.length - 1) / 2) * 22}" dominant-baseline="middle" text-anchor="middle" font-family="-apple-system, Helvetica, Arial" font-size="16" fill="#555">${escapeXml(line)}</text>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#e5e5e5"/><rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" fill="none" stroke="#bbb"/>${text}</svg>`;
  return {
    kind: "placeholder",
    src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    width: w,
    height: h,
    label: lines.join(" "),
  };
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] as string);
}
