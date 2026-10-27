import type { QcMode, QcOptions } from "@core/types";
import { copy } from "@/copy";
import { Field } from "../ui/Field";
import { Tag } from "../ui/Tag";

const MODES: QcMode[] = ["manual", "auto", "auto_ai"];

export function QcModePicker({
  mode,
  onModeChange,
  options,
  onOptionsChange,
  showResolution,
  aiReviewAvailable,
}: {
  mode: QcMode;
  onModeChange: (mode: QcMode) => void;
  options: QcOptions;
  onOptionsChange: (options: QcOptions) => void;
  showResolution: boolean;
  /** Off under demo access: reruns never call the demo Worker. */
  aiReviewAvailable: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2" role="radiogroup" aria-label={copy.run.qcTitle}>
        {MODES.map((m) => {
          const disabled = m === "auto_ai" && !aiReviewAvailable;
          return (
            <label key={m} className="ui-choice" data-disabled={disabled}>
              <input type="radio" name="qc-mode" checked={mode === m} disabled={disabled} onChange={() => onModeChange(m)} />
              <span className="flex flex-col">
                <span className="flex items-center gap-2">
                  {copy.run.qcModes[m].label}
                  {m === "auto_ai" && <Tag tone="strong">{copy.common.usesAi}</Tag>}
                </span>
                <span className="ui-small ui-muted">{disabled ? copy.run.aiReviewDemo : copy.run.qcModes[m].hint}</span>
              </span>
            </label>
          );
        })}
      </div>
      {mode !== "manual" && showResolution && (
        <div className="grid max-w-md grid-cols-2 gap-4">
          <Field label={copy.run.minPpiPrint} htmlFor="ppi-print">
            <input
              id="ppi-print"
              type="number"
              className="ui-input"
              value={options.minPpiPrint}
              onChange={(e) => onOptionsChange({ ...options, minPpiPrint: Number(e.target.value) || 0 })}
            />
          </Field>
          <Field label={copy.run.minPpiWeb} htmlFor="ppi-web">
            <input
              id="ppi-web"
              type="number"
              className="ui-input"
              value={options.minPpiWeb}
              onChange={(e) => onOptionsChange({ ...options, minPpiWeb: Number(e.target.value) || 0 })}
            />
          </Field>
        </div>
      )}
    </div>
  );
}
