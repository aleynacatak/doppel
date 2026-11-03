import type { PreviewImage } from "@core/types";
import { copy } from "@/copy";

/** An output preview (real image or gray placeholder) in a fixed-height box. */
export function Preview({ preview, height = 180, status }: { preview?: PreviewImage; height?: number; status?: string }) {
  return (
    <div className="flex items-center justify-center overflow-hidden bg-muted [&_img]:max-h-full [&_img]:max-w-full [&_img]:object-contain" style={{ height }}>
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview.src} alt={preview.label} />
      ) : (
        <span className="text-sm text-muted-foreground">{status ?? copy.common.noPreview}</span>
      )}
    </div>
  );
}
