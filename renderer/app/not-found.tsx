import { EmptyState } from "@/components/common/EmptyState";
import { copy } from "@/copy";
import { ButtonLink } from "@/components/common/ButtonLink";

export default function NotFound() {
  return <EmptyState title={copy.common.notFound} action={<ButtonLink href="/">{copy.nav.newTask}</ButtonLink>} />;
}
