import type { EnvironmentCheck } from "@core/types";
import { copy } from "@/copy";
import { Notice } from "../common/Notice";
import { Button } from "@/components/ui/button";

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
          <Button variant="outline" onClick={onRunAnyway}>{copy.run.runAnyway}</Button>
          <Button onClick={onRepair}>
            {copy.run.repairWithAi}
          </Button>
        </>
      }
    >
      <ul className="flex flex-col gap-1">
        {env.versionMismatch && env.currentVersion && <li>{copy.run.envVersion(appName, env.routineVersion, env.currentVersion)}</li>}
        {env.missingFonts.map((f) => (
          <li key={f}>{copy.run.envFont(f)}</li>
        ))}
      </ul>
    </Notice>
  );
}
