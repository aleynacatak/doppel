import { app, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { getFile, getMe, parseFigmaLink } from "../../adapters/figma/figmaRest";
import type { FigmaPluginBridge } from "../../adapters/figma/pluginBridge";
import type { CheckResult, FigmaSetup } from "../types";
import { errorMessage, nowIso } from "../util";
import type { SecretStore } from "./secretStore";
import { secretHint } from "./secretStore";
import type { SettingsService } from "./settingsService";

/**
 * Connect apps → Figma: the Doppl plugin (open sessions, pairing code, port), and optionally an access token
 * and files connected by link (read without the plugin, opened in Figma with one click).
 */
export class FigmaService {
  constructor(
    private readonly deps: {
      settings: SettingsService;
      secrets: SecretStore;
      bridge: FigmaPluginBridge;
      userData: string;
      onChange: () => void;
    },
  ) {}

  /** The built plugin shipped with the app (packaged: Resources/figma-plugin; dev: the repo folder). */
  private bundledPlugin() {
    return app.isPackaged ? path.join(process.resourcesPath, "figma-plugin") : path.join(app.getAppPath(), "figma-plugin");
  }

  /** Where the designer imports the plugin from: a copy in Doppl's data folder, with this Mac's port written in. */
  pluginFolder() {
    return path.join(this.deps.userData, "Figma plugin");
  }

  /**
   * Copies the plugin into pluginFolder() with the configured port in the manifest's devAllowedDomains and the
   * window's connection address. Called at startup and when the port changes; the folder stays stable across
   * app updates, so the designer imports it once.
   */
  async preparePlugin() {
    const port = this.deps.settings.current.figmaPort;
    const from = this.bundledPlugin();
    const to = this.pluginFolder();
    await fs.mkdir(path.join(to, "dist"), { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.join(from, "manifest.json"), "utf8"));
    manifest.networkAccess.devAllowedDomains = [`ws://localhost:${port}`];
    await fs.writeFile(path.join(to, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.copyFile(path.join(from, "dist", "code.js"), path.join(to, "dist", "code.js"));
    const ui = await fs.readFile(path.join(from, "dist", "ui.html"), "utf8");
    await fs.writeFile(path.join(to, "dist", "ui.html"), ui.replace(/<meta name="doppl-port" content="\d+"/, `<meta name="doppl-port" content="${port}"`));
  }

  async describe(): Promise<FigmaSetup> {
    const token = await this.deps.secrets.get("figmaToken");
    return {
      token: { saved: !!token, hint: secretHint(token) },
      files: this.deps.settings.current.figmaFiles,
      sessions: this.deps.bridge.list(),
      pairingCode: this.deps.settings.current.figmaPairingCode,
      port: this.deps.settings.current.figmaPort,
      pluginFolder: this.pluginFolder(),
    };
  }

  private fail(err: unknown): CheckResult<FigmaSetup> {
    return { ok: false, error: { code: "figma", message: errorMessage(err) } };
  }

  async saveToken(token: string): Promise<CheckResult<FigmaSetup>> {
    const value = token.trim();
    if (!value) return { ok: false, error: { code: "figma", message: "Paste your Figma access token." } };
    try {
      await getMe(value);
      await this.deps.secrets.set("figmaToken", value);
      this.deps.onChange();
      return { ok: true, value: await this.describe() };
    } catch (err) {
      return this.fail(err);
    }
  }

  async clearToken(): Promise<FigmaSetup> {
    await this.deps.secrets.set("figmaToken", null);
    this.deps.onChange();
    return this.describe();
  }

  async addLink(url: string): Promise<CheckResult<FigmaSetup>> {
    const parsed = parseFigmaLink(url);
    if (!parsed) return { ok: false, error: { code: "figma", message: "That doesn't look like a Figma file link. Copy it from Figma with Share → Copy link." } };
    const token = await this.deps.secrets.get("figmaToken");
    if (!token) return { ok: false, error: { code: "figma", message: "Add your Figma access token first." } };
    try {
      const data = await getFile(token, parsed.key, 1);
      const files = this.deps.settings.current.figmaFiles.filter((f) => f.key !== parsed.key);
      files.push({
        key: parsed.key,
        url: `https://www.figma.com/design/${parsed.key}`,
        name: data.name,
        lastModified: data.lastModified,
        thumbnailUrl: data.thumbnailUrl,
        addedAt: nowIso(),
      });
      await this.deps.settings.save({ figmaFiles: files });
      this.deps.onChange();
      return { ok: true, value: await this.describe() };
    } catch (err) {
      return this.fail(err);
    }
  }

  async removeFile(key: string): Promise<FigmaSetup> {
    await this.deps.settings.save({ figmaFiles: this.deps.settings.current.figmaFiles.filter((f) => f.key !== key) });
    this.deps.onChange();
    return this.describe();
  }

  async showPlugin() {
    await this.preparePlugin();
    shell.showItemInFolder(path.join(this.pluginFolder(), "manifest.json"));
  }

  /** Settings → Figma port changed: rewrite the plugin copy and listen on the new port. */
  async portChanged() {
    await this.preparePlugin().catch((err) => console.error("[figma plugin] couldn't prepare the plugin folder:", err));
    this.deps.bridge.restart();
    this.deps.onChange();
  }
}
