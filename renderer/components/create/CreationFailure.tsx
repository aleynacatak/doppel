import type { Creation } from "@core/types";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { Details } from "../common/Details";
import { Notice } from "../common/Notice";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/common/ButtonLink";

/** What went wrong, in plain language, with the action that helps (from the error's `action`). */
export function CreationFailure({
  creation,
  onRetry,
  onContinue,
  onStartOver,
  onDiscard,
  onChangeRequest,
}: {
  creation: Creation;
  onRetry: () => void;
  onContinue: () => void;
  onStartOver: () => void;
  onDiscard: () => void;
  onChangeRequest: () => void;
}) {
  const error = creation.error;
  const action = error?.action;
  const settingsAction = action === "settings" || action === "own-key";
  // Not design work to automate (a greeting, a question): the designer changes the request; trying again can't help.
  if (error?.kind === "not-a-task") {
    return (
      <Notice
        title={copy.create.notATaskTitle}
        actions={
          <>
            <Button onClick={onChangeRequest}>
              {copy.create.changeRequest}
            </Button>
            <Button variant="outline" onClick={onDiscard}>{copy.common.discard}</Button>
          </>
        }
      >
        <p>{error.message}</p>
        <p className="text-sm text-muted-foreground">{copy.create.notATaskHint}</p>
      </Notice>
    );
  }
  return (
    <Notice
      tone="error"
      title={creation.mode === "refine" ? copy.create.failedRefineTitle : creation.mode === "repair" ? copy.create.failedRepairTitle : copy.create.failedTitle}
      actions={
        <>
          {error?.kind === "app-not-connected" && <ButtonLink href="/connect">{copy.common.connectApps}</ButtonLink>}
          {error?.kind === "needs-flow" && (
            <ButtonLink href="/" variant="default">
              {copy.refine.planFlow}
            </ButtonLink>
          )}
          {error?.kind === "plugin-not-connected" && creation.task.documentId && (
            <Button variant="outline" onClick={() => doppel().openDocument(creation.task.appId, creation.task.documentId!)}>{copy.connect.figma.openInFigma}</Button>
          )}
          {settingsAction && (
            <ButtonLink href="/settings" variant="default">
              {copy.create.actions[action]}
            </ButtonLink>
          )}
          {creation.canContinue && (
            <Button onClick={onContinue}>
              {copy.create.continue}
            </Button>
          )}
          {action === "start-over" ? (
            <Button variant={creation.canContinue ? "outline" : "default"} onClick={onStartOver}>
              {copy.create.actions["start-over"]}
            </Button>
          ) : (
            <Button variant={settingsAction || creation.canContinue ? "outline" : "default"} onClick={onRetry}>
              {creation.canContinue ? copy.create.startOver : copy.common.tryAgain}
            </Button>
          )}
          <Button variant="outline" onClick={onDiscard}>{copy.common.discard}</Button>
        </>
      }
    >
      <p>{error?.message}</p>
      {creation.mode === "refine" && <p className="text-sm">{copy.refine.failedNote}</p>}
      <Details text={error?.detail} />
      {creation.canContinue ? (
        <p className="text-sm text-muted-foreground">{copy.create.continueHint}</p>
      ) : (
        creation.aiCalls > 0 && action !== "start-over" && <p className="text-sm text-muted-foreground">{copy.create.retryHint}</p>
      )}
    </Notice>
  );
}
