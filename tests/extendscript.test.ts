import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import { assembleScript } from "../electron/adapters/adobe/bridge";
import { indesignBridge } from "../electron/adapters/indesign/bridge";
import * as indesign from "../electron/adapters/indesign/jsx/scripts";
import { photoshopBridge } from "../electron/adapters/photoshop/bridge";
import * as photoshop from "../electron/adapters/photoshop/jsx/scripts";

// InDesign and Photoshop run ExtendScript (ES3). Every script, assembled exactly as the apps receive it (JSON
// polyfill + helper library + script), must parse as ES3: no let/const, arrow functions, template literals…

function scripts(module: Record<string, unknown>, wrap: (body: string) => string) {
  const list = Object.entries(module).filter((e): e is [string, string] => typeof e[1] === "string");
  return [...list, ["wrapped routine", wrap("ctx.log(1);")] as [string, string]];
}

describe("ExtendScript stays ES3", () => {
  it.each(scripts(photoshop, photoshop.wrapItem))("Photoshop %s", (_name, main) => {
    expect(() => parse(assembleScript(photoshopBridge.spec, main).source, { ecmaVersion: 3, allowReserved: true })).not.toThrow();
  });
  it.each(scripts(indesign, indesign.wrapRoutine))("InDesign %s", (_name, main) => {
    expect(() => parse(assembleScript(indesignBridge.spec, main).source, { ecmaVersion: 3, allowReserved: true })).not.toThrow();
  });
});
