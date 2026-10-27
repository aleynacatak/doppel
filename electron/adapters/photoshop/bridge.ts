import { AdobeBridge } from "../adobe/bridge";
import { DOPPL_PS_LIB } from "./jsx/lib";

// Photoshop on the shared Adobe bridge (adapters/adobe/bridge.ts): `do javascript … with arguments`. While a
// script runs, dialogs are off and ruler units are pixels; both are restored afterwards.

export const PHOTOSHOP_BUNDLE_ID = "com.adobe.Photoshop";

export const photoshopBridge = new AdobeBridge({
  appId: "photoshop",
  bundleId: PHOTOSHOP_BUNDLE_ID,
  shortName: "Photoshop",
  folderPrefix: "Adobe Photoshop",
  runCommand: "do javascript",
  library: DOPPL_PS_LIB,
  prologue: [
    "var previousDialogs = app.displayDialogs;",
    "var previousUnits = app.preferences.rulerUnits;",
    "app.displayDialogs = DialogModes.NO;",
    "app.preferences.rulerUnits = Units.PIXELS;",
  ],
  epilogue: ["app.preferences.rulerUnits = previousUnits;", "app.displayDialogs = previousDialogs;"],
});
