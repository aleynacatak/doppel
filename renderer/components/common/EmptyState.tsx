import type { ReactNode } from "react";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {body && <EmptyDescription>{body}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}
