import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import { assembleScript } from "../electron/adapters/adobe/bridge";
import { indesignBridge } from "../electron/adapters/indesign/bridge";
import { lintExtendScript } from "../electron/adapters/indesign/lint";
import * as indesign from "../electron/adapters/indesign/jsx/scripts";
import { photoshopBridge } from "../electron/adapters/photoshop/bridge";
import { hiddenFailures, lintPhotoshopScript } from "../electron/adapters/photoshop/lint";
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

describe("Photoshop scripts don't hide failing steps", () => {
  const mask = 'var d = new ActionDescriptor();\nexecuteAction(charIDToTypeID("Mk  "), d, DialogModes.NO);';
  const issues = (script: string) => lintPhotoshopScript(script).filter((m) => m.includes("empty catch"));

  it("refuses Photoshop commands in an empty catch, nested blocks included", () => {
    expect(issues(`try { ${mask} } catch (eM) {}`)).toEqual([expect.stringContaining("A Photoshop step is wrapped in an empty catch")]);
    expect(issues(`try {\n if (hasSel) { ${mask} } else { doc.selection.selectAll(); }\n} catch (e) { }\ntry { doc.selection.contract(2); } catch (eC) {}`)).toEqual([
      expect.stringContaining("2 Photoshop steps are wrapped"),
    ]);
  });

  it("allows harmless guards and catches that do something", () => {
    expect(issues("try { doc.backgroundLayer.isBackgroundLayer = false; } catch (eB) {}")).toEqual([]);
    expect(issues(`try { ${mask} } catch (e) { ctx.log("No mask: " + e.message); throw e; }`)).toEqual([]);
    expect(hiddenFailures("var s = '}'; try { executeAction(1); } catch (e) {}")).toHaveLength(1);
  });
});

describe("InDesign scripts never save over the designer's files", () => {
  const saving = (script: string) => lintExtendScript(script).filter((m) => /saves? over/.test(m));
  it("refuses saving a document in place, or closing it with a save", () => {
    expect(saving("doc.save();")).toHaveLength(1);
    expect(saving("var d = app.open(File(params.file));\nd.close(SaveOptions.YES);")).toHaveLength(1);
  });
  it("lets a routine close without saving and export into its working folder", () => {
    expect(saving('var card = ctx.open(params.template);\nctx.exportPdf(card, ctx.workDir + "/a.pdf", { preset: params.preset });\nctx.close(card);')).toEqual([]);
  });
});

describe("InDesign scripts go through the helpers Doppl can check", () => {
  const helpers = /ctx\.(open|close|exportPdf|fitText)/;
  const issues = (script: string) => lintExtendScript(script).filter((m) => helpers.test(m));

  it("asks for ctx.open and ctx.close, so Doppl checks what the routine opens", () => {
    expect(issues("var t = app.open(File(params.template), false);\nt.close(SaveOptions.NO);")).toEqual([
      expect.stringContaining("ctx.open(path)"),
      expect.stringContaining("ctx.close(d)"),
    ]);
  });

  it("asks for ctx.exportPdf, where crop marks survive a preset", () => {
    expect(issues('doc.exportFile(ExportFormat.PDF_TYPE, File(ctx.workDir + "/a.pdf"), false, app.pdfExportPresets.itemByName("[High Quality Print]"));')).toEqual([
      expect.stringContaining("ctx.exportPdf"),
    ]);
    expect(issues('doc.exportFile(ExportFormat.PNG_FORMAT, File(ctx.workDir + "/a.png"), false);')).toEqual([]);
  });

  it("asks for ctx.fitText instead of a loop that shrinks only the text inside the frame", () => {
    expect(issues("var s = 12;\nwhile (tf.overflows && s > 6) { s -= 0.5; tf.texts.everyItem().pointSize = s; }")).toEqual([expect.stringContaining("ctx.fitText")]);
    expect(issues("do { size--; frame.texts[0].pointSize = size; } while (frame.overflows);")).toEqual([expect.stringContaining("ctx.fitText")]);
    // Setting a size, and adding pages while a story overflows, are fine.
    expect(issues("for (var i = 0; i < 3; i++) { titles[i].texts[0].pointSize = 24; }\nwhile (story.overflows && added < 200) { addPage(); }")).toEqual([]);
    expect(issues("var fit = ctx.fitText(frame, { minSize: 7 });")).toEqual([]);
  });
});
