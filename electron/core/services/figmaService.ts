import { app, shell } from "electron";
import path from "node:path";
import { getFile, getMe, parseFigmaLink } from "../../adapters/figma/figmaRest";
import type { FigmaPluginBridge } from "../../adapters/figma/pluginBridge";
import type { CheckResult, FigmaSetup } from "../types";
import { errorMessage, nowIso } from "../util";
import type { SecretStore } from "./secretStore";
import { secretHint } from "./secretStore";
import type { SettingsService } from "./settingsService";

/** Connect apps → Figma: the access token, the files connected by link, and the plugin's status. */
export class FigmaService {
  constructor(
    private readonly deps: {
      settings: SettingsService;
      secrets: SecretStore;
      bridge: FigmaPluginBridge;
      onChange: () => void;
    },
  ) {}

  /** figma-plugin/ next to the app (packaged: Resources/figma-plugin; dev: the repo folder). */
  pluginFolder() {
    return app.isPackaged ? path.join(process.resourcesPath, "figma-plugin") : path.join(app.getAppPath(), "figma-plugin");
  }

  async describe(): Promise<FigmaSetup> {
    const token = await this.deps.secrets.get("figmaToken");
    const { connected, info } = this.deps.bridge.status();
    const files = this.deps.settings.current.figmaFiles;
    const matched = info
      ? (files.find((f) => info.fileKey && f.key === info.fileKey) ?? files.find((f) => f.name.toLowerCase() === info.fileName.toLowerCase()))
      : undefined;
    return {
      token: { saved: !!token, hint: secretHint(token) },
      files,
      plugin: { connected, fileName: info?.fileName, pageName: info?.pageName, matchedKey: matched?.key },
      pairingCode: this.deps.settings.current.figmaPairingCode,
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

  showPlugin() {
    shell.showItemInFolder(path.join(this.pluginFolder(), "manifest.json"));
  }
}
