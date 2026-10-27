import type { PreviewImage } from "@core/types";
import { copy } from "@/copy";

/** An output preview (real image or gray placeholder) in a fixed-height box. */
export function Preview({ preview, height = 180, status }: { preview?: PreviewImage; height?: number; status?: string }) {
  return (
    <div className="ui-preview" style={{ height }}>
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview.src} alt={preview.label} />
      ) : (
        <span className="ui-small ui-muted">{status ?? copy.common.noPreview}</span>
      )}
    </div>
  );
}
