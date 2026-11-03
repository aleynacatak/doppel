import type { Creation, PortabilityIssue } from "@core/types";
import { useState } from "react";
import { copy } from "@/copy";
import { Field } from "../common/Field";
import { PortabilityIssues } from "./PortabilityIssues";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SaveRoutineForm({
  creation,
  onSave,
  onDiscard,
}: {
  creation: Creation;
  onSave: (name: string, acceptIssues: boolean) => Promise<PortabilityIssue[] | null>;
  onDiscard: () => void;
}) {
  const [name, setName] = useState(creation.draft?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<PortabilityIssue[] | null>(null);

  const save = async (accept: boolean) => {
    setSaving(true);
    const result = await onSave(name, accept);
    setIssues(result);
    setSaving(false);
  };

  const saveLabel = creation.flowLink ? copy.create.compatSaved : creation.mode === "repair" ? copy.create.saveRepair(creation.nextVersion ?? 2) : copy.create.saveCreate;
  return (
    <div className="flex flex-col gap-4">
      <Field label={copy.create.nameLabel} htmlFor="routine-name">
        <Input id="routine-name" className="max-w-md" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      {issues && issues.length > 0 ? (
        <PortabilityIssues
          issues={issues}
          actions={
            <>
              <Button variant="outline" onClick={() => save(true)} disabled={saving}>
                {copy.create.saveAnyway}
              </Button>
              <Button variant="outline" onClick={onDiscard}>{copy.common.discard}</Button>
            </>
          }
        />
      ) : (
        <div className="flex gap-2">
          <Button onClick={() => save(false)} disabled={saving || !name.trim()}>
            {saveLabel}
          </Button>
          <Button variant="outline" onClick={onDiscard}>{copy.common.discard}</Button>
        </div>
      )}
    </div>
  );
}
