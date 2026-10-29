import { firstVersions } from "../../core/blocks/select";
import { PHOTOSHOP_HELPERS } from "./helpers";
import { DOPPL_PS_RUNTIME } from "./jsx/lib";

/** The library prepended to a Photoshop script: the runtime, then the helpers (default: every helper's first version). */
export function photoshopLibrary(helpers: { code: string }[] = firstVersions(PHOTOSHOP_HELPERS)): string {
  return `${DOPPL_PS_RUNTIME}\n${helpers.map((h) => h.code).join("\n\n")}\n`;
}
