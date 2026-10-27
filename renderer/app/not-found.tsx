import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { copy } from "@/copy";

export default function NotFound() {
  return <EmptyState title={copy.common.notFound} action={<ButtonLink href="/">{copy.nav.newTask}</ButtonLink>} />;
}
