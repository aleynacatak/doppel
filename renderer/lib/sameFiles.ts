import type { AppId, InputValue, MatchRule, ParamValue, QcMode, QcOptions, Run } from "@core/types";

/**
 * What "Run with same files" starts from: what an earlier run used, for the run screen to fill in.
 * Not whether it ran on a copy or the original: that starts on the copy again, so a rerun doesn't change an original twice.
 */
export interface SameFiles {
  inputs: Record<string, InputValue>;
  outputFolders: Record<string, string>;
  settings: Record<string, ParamValue>;
  matches: Record<string, MatchRule>;
  columns: Record<string, Record<string, string>>;
  documents: Partial<Record<AppId, string>>;
  qcMode: QcMode;
  qcOptions?: QcOptions;
}

export function sameFilesOfRun(run: Run): SameFiles {
  return {
    inputs: run.inputs,
    outputFolders: run.outputFolders,
    settings: run.settings ?? {},
    matches: run.matches ?? {},
    columns: run.columns ?? {},
    documents: run.options.documents ?? {},
    qcMode: run.qcMode,
    qcOptions: run.options.qcOptions,
  };
}

/** The values for nodes still in the flow: it may have changed since that run. */
export function forNodes<T>(values: Record<string, T>, nodes: { id: string }[]): Record<string, T> {
  return Object.fromEntries(Object.entries(values).filter(([id]) => nodes.some((n) => n.id === id)));
}
