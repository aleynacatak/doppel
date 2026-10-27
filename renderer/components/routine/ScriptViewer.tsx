import { copy } from "@/copy";

export function ScriptViewer({ script, language }: { script: string; language: string }) {
  const lines = script.split("\n");
  const width = String(lines.length).length;
  return (
    <div className="flex flex-col gap-1">
      <div className="ui-small ui-muted">{copy.routine.scriptLanguage(language)}</div>
      <pre className="ui-code max-h-[480px] p-3" aria-label={copy.routine.scriptTitle}>
        {lines.map((line, i) => `${String(i + 1).padStart(width)}  ${line}`).join("\n")}
      </pre>
    </div>
  );
}
