import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { fileName } from "@/lib/format";
import { Button } from "../ui/Button";

export function ReferencePicker({ files, onChange }: { files: string[]; onChange: (files: string[]) => void }) {
  const attach = async () => {
    const picked = await doppel().pickFiles({ multiple: true });
    onChange([...files, ...picked.filter((p) => !files.includes(p))]);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="ui-label">{copy.newTask.referencesLabel}</div>
      <p className="ui-small ui-muted">{copy.newTask.referencesHint}</p>
      {files.length > 0 && (
        <ul className="flex flex-col gap-1">
          {files.map((f) => (
            <li key={f} className="flex items-center gap-2">
              <span className="truncate" title={f}>
                {fileName(f)}
              </span>
              <Button variant="ghost" size="small" onClick={() => onChange(files.filter((x) => x !== f))}>
                {copy.newTask.remove}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button onClick={attach}>{copy.newTask.attach}</Button>
      </div>
    </div>
  );
}
