import { copy } from "@/copy";

export function ScriptViewer({ script, language }: { script: string; language: string }) {
  const lines = script.split("\n");
  const width = String(lines.length).length;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-sm text-muted-foreground">{copy.routine.scriptLanguage(language)}</div>
      <pre className="overflow-auto rounded-lg border bg-muted font-mono text-xs/relaxed whitespace-pre max-h-[480px] p-4" aria-label={copy.routine.scriptTitle}>
        {lines.map((line, i) => `${String(i + 1).padStart(width)}  ${line}`).join("\n")}
      </pre>
    </div>
  );
}
