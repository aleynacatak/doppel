import type { EnvironmentCheck } from "@core/types";
import { copy } from "@/copy";
import { Button } from "../ui/Button";
import { Notice } from "../ui/Notice";

export function EnvironmentWarning({
  env,
  appName,
  onRunAnyway,
  onRepair,
}: {
  env: EnvironmentCheck;
  appName: string;
  onRunAnyway: () => void;
  onRepair: () => void;
}) {
  return (
    <Notice
      tone="warning"
      title={copy.run.envTitle}
      actions={
        <>
          <Button onClick={onRunAnyway}>{copy.run.runAnyway}</Button>
          <Button variant="primary" onClick={onRepair}>
            {copy.run.repairWithAi}
          </Button>
        </>
      }
    >
      <ul className="flex flex-col gap-0.5">
        {env.versionMismatch && env.currentVersion && <li>{copy.run.envVersion(appName, env.routineVersion, env.currentVersion)}</li>}
        {env.missingFonts.map((f) => (
          <li key={f}>{copy.run.envFont(f)}</li>
        ))}
      </ul>
    </Notice>
  );
}
