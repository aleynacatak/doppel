import { AdobeBridge, BridgeError } from "../adobe/bridge";
import { indesignLibrary } from "./library";

// InDesign on the shared Adobe bridge (adapters/adobe/bridge.ts): `do script … language javascript`, with
// dialogs suppressed while a script runs.

export { BridgeError };

export const INDESIGN_BUNDLE_ID = "com.adobe.InDesign";

export const indesignBridge = new AdobeBridge({
  appId: "indesign",
  bundleId: INDESIGN_BUNDLE_ID,
  shortName: "InDesign",
  folderPrefix: "Adobe InDesign",
  runCommand: "do script",
  delivery: "file",
  library: indesignLibrary(),
  prologue: [
    "var previousLevel = app.scriptPreferences.userInteractionLevel;",
    "app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;",
  ],
  epilogue: ["app.scriptPreferences.userInteractionLevel = previousLevel;"],
});
