import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { Button } from "../ui/Button";
import { Notice } from "../ui/Notice";

/** macOS Automation permission was denied: explain how to turn it back on. */
export function PermissionHelp({ appName }: { appName: string }) {
  return (
    <Notice
      tone="warning"
      title={copy.connect.permission.title}
      actions={<Button onClick={() => doppel().openAutomationSettings()}>{copy.connect.permission.open}</Button>}
    >
      <p>{copy.connect.permission.body(appName)}</p>
      <ol className="list-decimal pl-5">
        {copy.connect.permission.steps(appName).map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </Notice>
  );
}
