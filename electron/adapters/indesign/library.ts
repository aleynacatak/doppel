import { firstVersions } from "../../core/blocks/select";
import { INDESIGN_HELPERS } from "./helpers";
import { DOPPL_LIB } from "./jsx/lib";

/** The library prepended to an InDesign script: the runtime, then the ctx helpers (default: their first versions). */
export function indesignLibrary(helpers: { code: string }[] = firstVersions(INDESIGN_HELPERS)): string {
  return `${DOPPL_LIB}\n${helpers.map((h) => h.code).join("\n\n")}\n`;
}
