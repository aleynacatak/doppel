import { copy } from "@/copy";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/** The technical text behind a plain message (an app's own error), folded away until asked for. */
export function Details({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <Collapsible className="text-sm text-muted-foreground">
      <CollapsibleTrigger className="text-primary underline-offset-4 hover:underline">{copy.common.details}</CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-1 whitespace-pre-wrap break-words">{text}</p>
      </CollapsibleContent>
    </Collapsible>
  );
}
