import path from "node:path";
import { FigmaAdapter } from "../adapters/figma/figmaAdapter";
import { FigmaPluginBridge } from "../adapters/figma/pluginBridge";
import { InDesignAdapter } from "../adapters/indesign/indesignAdapter";
import { PhotoshopAdapter } from "../adapters/photoshop/photoshopAdapter";
import { AdapterRegistry } from "../adapters/registry";
import { blocks } from "../core/blocks/registry";
import { runHelperTests } from "../core/blocks/testRunner";
import { SecretStore } from "../core/services/secretStore";
import { SettingsService } from "../core/services/settingsService";
import { JsonStorage } from "../core/services/storage";

// `npm run test:helpers -- [--app photoshop] [--ids ps.maskWhiteBackground,…] [--all-versions]`: runs the building
// blocks' tests in the real apps (headless Electron). Apps that aren't open are skipped, not failed.

export async function runHelpersCli(argv: string[], paths: { userData: string; temp: string }, log = (s: string) => console.log(s)): Promise<number> {
  const args = argv.slice(argv.indexOf("--doppl-test-helpers") + 1);
  const get = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const settings = new SettingsService(new JsonStorage(paths.userData));
  await settings.load();
  const secrets = new SecretStore(paths.userData);
  const timeout = () => settings.current.scriptTimeoutSec;
  const bridge = new FigmaPluginBridge(() => settings.current.figmaPairingCode, () => settings.current.figmaPort);
  const adapters = new AdapterRegistry([
    new InDesignAdapter({ getTimeoutSec: timeout, onStatusChange: () => undefined }),
    new PhotoshopAdapter({ getTimeoutSec: timeout, onStatusChange: () => undefined }),
    new FigmaAdapter({ getToken: () => secrets.get("figmaToken"), getFiles: () => settings.current.figmaFiles, bridge, getTimeoutSec: timeout }),
  ]);
  blocks.usePersonalDir(path.join(paths.userData, "helpers"));
  const app = get("app");
  const ids = get("ids")?.split(",").map((s) => s.trim());
  let defs = (args.includes("--all-versions") ? blocks.all() : blocks.latest()).filter((d) => d.source === "builtin" || args.includes("--include-mine"));
  if (app) defs = defs.filter((d) => d.app === app);
  if (ids) defs = defs.filter((d) => ids.includes(d.id));
  log(`Testing ${defs.length} building block(s) in the apps…`);
  const results = await runHelperTests(defs, { adapters, registry: blocks, statusOf: (id) => adapters.get(id).getStatus(), workRoot: path.join(paths.temp, "doppl-block-tests") }, log);
  const failed = results.filter((r) => !r.passed && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  log(`${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
  return failed ? 1 : 0;
}
