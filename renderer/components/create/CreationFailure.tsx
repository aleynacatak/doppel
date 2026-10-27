import type { Creation } from "@core/types";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { Button, ButtonLink } from "../ui/Button";
import { Notice } from "../ui/Notice";

/** What went wrong, in plain language, with the action that helps (from the error's `action`). */
export function CreationFailure({
  creation,
  onRetry,
  onStartOver,
  onDiscard,
}: {
  creation: Creation;
  onRetry: () => void;
  onStartOver: () => void;
  onDiscard: () => void;
}) {
  const error = creation.error;
  const action = error?.action;
  const settingsAction = action === "settings" || action === "own-key";
  return (
    <Notice
      tone="error"
      title={creation.mode === "repair" ? copy.create.failedRepairTitle : copy.create.failedTitle}
      actions={
        <>
          {error?.kind === "app-not-connected" && <ButtonLink href="/connect">{copy.common.connectApps}</ButtonLink>}
          {error?.kind === "plugin-not-connected" && creation.task.documentId && (
            <Button onClick={() => doppel().openDocument(creation.task.appId, creation.task.documentId!)}>{copy.connect.figma.openInFigma}</Button>
          )}
          {settingsAction && (
            <ButtonLink href="/settings" variant="primary">
              {copy.create.actions[action]}
            </ButtonLink>
          )}
          {action === "start-over" ? (
            <Button variant="primary" onClick={onStartOver}>
              {copy.create.actions["start-over"]}
            </Button>
          ) : (
            <Button variant={settingsAction ? "secondary" : "primary"} onClick={onRetry}>
              {copy.common.tryAgain}
            </Button>
          )}
          <Button onClick={onDiscard}>{copy.common.discard}</Button>
        </>
      }
    >
      <p>{error?.message}</p>
      {error?.detail && <p className="ui-muted">{error.detail}</p>}
    </Notice>
  );
}
