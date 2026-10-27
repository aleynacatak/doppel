import type { DocumentRef } from "@core/types";

const DOPPEL_COPY = /_doppel(-\d+)?(\.indd)$/i;

/**
 * The document to preselect: the active one, unless it is a Doppel copy whose original is also open.
 * After a run on a copy, the copy is in front; rerunning should start from the original again.
 */
export function defaultDocument(docs: DocumentRef[]): DocumentRef | undefined {
  const active = docs.find((d) => d.active) ?? docs[0];
  if (active && DOPPEL_COPY.test(active.name)) {
    const originalName = active.name.replace(DOPPEL_COPY, "$2");
    const original = docs.find((d) => d.name === originalName);
    if (original) return original;
  }
  return active;
}
