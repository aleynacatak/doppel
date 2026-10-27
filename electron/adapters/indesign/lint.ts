import { lintExtendScript as lintAdobe } from "../adobe/lint";

/** Checks an InDesign routine body (`function (doc, params, ctx)`) before it runs. */
export function lintExtendScript(script: string): string[] {
  return lintAdobe(script, { appName: "InDesign", signature: "doc, params, ctx" });
}
