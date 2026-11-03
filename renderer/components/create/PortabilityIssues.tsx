import type { PortabilityIssue } from "@core/types";
import { copy } from "@/copy";
import { Notice } from "../common/Notice";

export function PortabilityIssues({ issues, actions }: { issues: PortabilityIssue[]; actions?: React.ReactNode }) {
  return (
    <Notice tone="error" title={copy.create.portabilityTitle} actions={actions}>
      <p>{copy.create.portabilityBody}</p>
      <ul className="flex flex-col gap-1.5">
        {issues.map((i) => (
          <li key={i.line} className="flex flex-col">
            <span className="text-sm text-muted-foreground">
              {copy.create.portabilityLine(i.line)} · {i.message}
            </span>
            <code className="overflow-auto rounded-lg border bg-muted font-mono text-xs/relaxed whitespace-pre px-2 py-1.5">{i.text}</code>
          </li>
        ))}
      </ul>
    </Notice>
  );
}
