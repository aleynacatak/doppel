import { copy } from "@/copy";

/** The technical text behind a plain message (an app's own error), folded away until asked for. */
export function Details({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <details className="ui-small ui-muted">
      <summary className="ui-link">{copy.common.details}</summary>
      <p className="mt-1 whitespace-pre-wrap break-words">{text}</p>
    </details>
  );
}
