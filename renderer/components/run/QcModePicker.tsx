import type { QcMode, QcOptions } from "@core/types";
import { copy } from "@/copy";
import { Field } from "../common/Field";
import { Tag } from "../common/Tag";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

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
    <div className="flex flex-col gap-6">
      <RadioGroup className="flex flex-col gap-3" aria-label={copy.run.qcTitle} value={mode} onValueChange={(next) => onModeChange(next as typeof mode)}>
        {MODES.map((m) => {
          const disabled = m === "auto_ai" && !aiReviewAvailable;
          return (
            <label key={m} className="flex items-start gap-2 data-[disabled=true]:text-muted-foreground" data-disabled={disabled}>
              <RadioGroupItem className="mt-0.5" value={m} disabled={disabled} />
              <span className="flex flex-col">
                <span className="flex items-center gap-2">
                  {copy.run.qcModes[m].label}
                  {m === "auto_ai" && <Tag tone="strong">{copy.common.usesAi}</Tag>}
                </span>
                <span className="text-sm text-muted-foreground">{disabled ? copy.run.aiReviewDemo : copy.run.qcModes[m].hint}</span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
      {mode !== "manual" && showResolution && (
        <div className="grid max-w-md grid-cols-2 gap-6">
          <Field label={copy.run.minPpiPrint} htmlFor="ppi-print">
            <Input
              id="ppi-print"
              type="number"
              value={options.minPpiPrint}
              onChange={(e) => onOptionsChange({ ...options, minPpiPrint: Number(e.target.value) || 0 })}
            />
          </Field>
          <Field label={copy.run.minPpiWeb} htmlFor="ppi-web">
            <Input
              id="ppi-web"
              type="number"
              value={options.minPpiWeb}
              onChange={(e) => onOptionsChange({ ...options, minPpiWeb: Number(e.target.value) || 0 })}
            />
          </Field>
        </div>
      )}
    </div>
  );
}
