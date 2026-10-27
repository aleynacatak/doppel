import type { PortabilityIssue } from "@core/types";
import { copy } from "@/copy";
import { Notice } from "../ui/Notice";

export function PortabilityIssues({ issues, actions }: { issues: PortabilityIssue[]; actions?: React.ReactNode }) {
  return (
    <Notice tone="error" title={copy.create.portabilityTitle} actions={actions}>
      <p>{copy.create.portabilityBody}</p>
      <ul className="flex flex-col gap-1">
        {issues.map((i) => (
          <li key={i.line} className="flex flex-col">
            <span className="ui-small ui-muted">
              {copy.create.portabilityLine(i.line)} · {i.message}
            </span>
            <code className="ui-code px-2 py-1">{i.text}</code>
          </li>
        ))}
      </ul>
    </Notice>
  );
}
