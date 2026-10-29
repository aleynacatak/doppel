import type { Creation } from "@core/types";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { Button, ButtonLink } from "../ui/Button";
import { Notice } from "../ui/Notice";

/** What went wrong, in plain language, with the action that helps (from the error's `action`). */
export function CreationFailure({
  creation,
  onRetry,
  onContinue,
  onStartOver,
  onDiscard,
}: {
  creation: Creation;
  onRetry: () => void;
  onContinue: () => void;
  onStartOver: () => void;
  onDiscard: () => void;
}) {
  const error = creation.error;
  const action = error?.action;
  const settingsAction = action === "settings" || action === "own-key";
  return (
    <Notice
      tone="error"
      title={creation.mode === "refine" ? copy.create.failedRefineTitle : creation.mode === "repair" ? copy.create.failedRepairTitle : copy.create.failedTitle}
      actions={
        <>
          {error?.kind === "app-not-connected" && <ButtonLink href="/connect">{copy.common.connectApps}</ButtonLink>}
          {error?.kind === "needs-flow" && (
            <ButtonLink href="/" variant="primary">
              {copy.refine.planFlow}
            </ButtonLink>
          )}
          {error?.kind === "plugin-not-connected" && creation.task.documentId && (
            <Button onClick={() => doppel().openDocument(creation.task.appId, creation.task.documentId!)}>{copy.connect.figma.openInFigma}</Button>
          )}
          {settingsAction && (
            <ButtonLink href="/settings" variant="primary">
              {copy.create.actions[action]}
            </ButtonLink>
          )}
          {creation.canContinue && (
            <Button variant="primary" onClick={onContinue}>
              {copy.create.continue}
            </Button>
          )}
          {action === "start-over" ? (
            <Button variant={creation.canContinue ? "secondary" : "primary"} onClick={onStartOver}>
              {copy.create.actions["start-over"]}
            </Button>
          ) : (
            <Button variant={settingsAction || creation.canContinue ? "secondary" : "primary"} onClick={onRetry}>
              {creation.canContinue ? copy.create.startOver : copy.common.tryAgain}
            </Button>
          )}
          <Button onClick={onDiscard}>{copy.common.discard}</Button>
        </>
      }
    >
      <p>{error?.message}</p>
      {creation.mode === "refine" && <p className="ui-small">{copy.refine.failedNote}</p>}
      {error?.detail && <p className="ui-muted">{error.detail}</p>}
      {creation.canContinue ? (
        <p className="ui-small ui-muted">{copy.create.continueHint}</p>
      ) : (
        creation.aiCalls > 0 && action !== "start-over" && <p className="ui-small ui-muted">{copy.create.retryHint}</p>
      )}
    </Notice>
  );
}
