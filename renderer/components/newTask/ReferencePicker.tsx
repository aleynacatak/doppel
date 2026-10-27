import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { fileName } from "@/lib/format";
import { Button } from "../ui/Button";

function PathList({ paths, onRemove }: { paths: string[]; onRemove: (p: string) => void }) {
  return (
    <ul className="flex flex-col gap-1">
      {paths.map((f) => (
        <li key={f} className="flex items-center gap-2">
          <span className="truncate" title={f}>
            {fileName(f)}
          </span>
          <Button variant="ghost" size="small" onClick={() => onRemove(f)}>
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
    <div className="flex flex-col gap-2">
      <div className="ui-label">{copy.newTask.referencesLabel}</div>
      <p className="ui-small ui-muted">{copy.newTask.referencesHint}</p>
      {files.length > 0 && <PathList paths={files} onRemove={(f) => onChange(files.filter((x) => x !== f))} />}
      {folders.length > 0 && (
        <>
          <PathList paths={folders} onRemove={(f) => onFoldersChange(folders.filter((x) => x !== f))} />
          <p className="ui-small ui-muted">{copy.newTask.folderNote}</p>
        </>
      )}
      <div className="flex gap-2">
        <Button onClick={attach}>{copy.newTask.attach}</Button>
        <Button onClick={addFolder}>{copy.newTask.addFolder}</Button>
      </div>
    </div>
  );
}
