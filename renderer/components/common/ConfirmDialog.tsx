"use client";

import { useCallback, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { copy } from "@/copy";

type Ask = { title: string; body: string; action: string; destructive?: boolean };

/** Asks before something lasting: render `dialog` once, then `await confirm({ ... })`. */
export function useConfirm() {
  const [open, setOpen] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const answer = useRef<(yes: boolean) => void>(() => undefined);
  const confirm = useCallback(
    (next: Ask) =>
      new Promise<boolean>((resolve) => {
        answer.current = resolve;
        setAsk(next);
        setOpen(true);
      }),
    [],
  );
  const finish = (yes: boolean) => {
    setOpen(false);
    answer.current(yes);
  };
  const dialog = (
    <AlertDialog open={open} onOpenChange={(next) => !next && finish(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{ask?.title}</AlertDialogTitle>
          <AlertDialogDescription>{ask?.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{copy.common.cancel}</AlertDialogCancel>
          <AlertDialogAction variant={ask?.destructive ? "destructive" : "default"} onClick={() => finish(true)}>
            {ask?.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return [confirm, dialog] as const;
}
