import { nativeImage } from "electron";
import path from "node:path";
import type { PreviewImage } from "../core/types";

const MAX_PREVIEW = 640;

function toPreview(image: Electron.NativeImage, label: string): PreviewImage | undefined {
  if (image.isEmpty()) return undefined;
  if (image.getSize().width > MAX_PREVIEW) image = image.resize({ width: MAX_PREVIEW, quality: "good" });
  const size = image.getSize();
  return {
    kind: "image",
    src: `data:image/jpeg;base64,${image.toJPEG(80).toString("base64")}`,
    width: size.width,
    height: size.height,
    label,
  };
}

/** Preview of a file on disk: images are downscaled, PDFs use the macOS Quick Look thumbnail. */
export async function filePreview(filePath: string, label = path.basename(filePath)): Promise<PreviewImage | undefined> {
  const ext = path.extname(filePath).toLowerCase();
  const image =
    ext === ".pdf" || ext === ".svg"
      ? await nativeImage.createThumbnailFromPath(filePath, { width: MAX_PREVIEW, height: MAX_PREVIEW })
      : nativeImage.createFromPath(filePath);
  return toPreview(image, label);
}

/** Preview of image bytes (PNG/JPEG), e.g. a Figma frame export. */
export function bufferPreview(bytes: Buffer, label: string): PreviewImage | undefined {
  return toPreview(nativeImage.createFromBuffer(bytes), label);
}
