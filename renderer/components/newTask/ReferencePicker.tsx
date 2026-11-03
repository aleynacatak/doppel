import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { fileName } from "@/lib/format";
import { Button } from "@/components/ui/button";

function PathList({ paths, onRemove }: { paths: string[]; onRemove: (p: string) => void }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {paths.map((f) => (
        <li key={f} className="flex items-center gap-2">
          <span className="truncate" title={f}>
            {fileName(f)}
          </span>
          <Button variant="ghost" size="sm" onClick={() => onRemove(f)}>
            {copy.newTask.remove}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** Sample files (data, text, images) and folders for the routine to try. */
export function ReferencePicker({
  files,
  onChange,
  folders,
  onFoldersChange,
}: {
  files: string[];
  onChange: (files: string[]) => void;
  folders: string[];
  onFoldersChange: (folders: string[]) => void;
}) {
  const attach = async () => {
    const picked = await doppel().pickFiles({ multiple: true });
    onChange([...files, ...picked.filter((p) => !files.includes(p))]);
  };
  const addFolder = async () => {
    const folder = await doppel().pickFolder();
    if (folder && !folders.includes(folder)) onFoldersChange([...folders, folder]);
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm font-medium">{copy.newTask.referencesLabel}</div>
      <p className="text-sm text-muted-foreground">{copy.newTask.referencesHint}</p>
      {files.length > 0 && <PathList paths={files} onRemove={(f) => onChange(files.filter((x) => x !== f))} />}
      {folders.length > 0 && (
        <>
          <PathList paths={folders} onRemove={(f) => onFoldersChange(folders.filter((x) => x !== f))} />
          <p className="text-sm text-muted-foreground">{copy.newTask.folderNote}</p>
        </>
      )}
      <div className="flex gap-2">
        <Button variant="outline" onClick={attach}>{copy.newTask.attach}</Button>
        <Button variant="outline" onClick={addFolder}>{copy.newTask.addFolder}</Button>
      </div>
    </div>
  );
}
