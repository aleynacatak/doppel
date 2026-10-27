import { MockAdapter } from "../mock/mockAdapter";
import { SOCIAL_FORMATS } from "./templates";

const MODEL_GUIDE = `Figma is scripted through the Doppel Figma plugin with the Figma Plugin API (modern JavaScript).
The plugin connects to Doppel over a local WebSocket. Routines receive params and call doppel.output({...})
for every frame they produce. Never reference file keys or local paths inside a routine.`;

interface Options {
  isConnected: () => boolean;
  setConnected: (value: boolean) => Promise<void>;
}

/** Mock Figma: no plugin and no WebSocket yet. "Check again" on the Connect screen flips it to connected. */
export function createFigmaMockAdapter(options: Options) {
  return new MockAdapter({
    id: "figma",
    name: "Figma",
    scriptLanguage: "Figma Plugin API (JS)",
    connection: "in-app-plugin",
    modelGuide: MODEL_GUIDE,
    version: "126.2",
    disconnectedStatus: "not-installed",
    isConnected: options.isConnected,
    setConnected: options.setConnected,
    documents: [
      {
        id: "figma:campaign-master",
        appId: "figma",
        name: "Campaign_Master.fig",
        active: true,
        frames: [
          { name: "Master visual", width: 1920, height: 1080 },
          { name: "Product hero", width: 1440, height: 900 },
          { name: "Logo lockup", width: 800, height: 400 },
        ],
      },
      {
        id: "figma:brand-kit",
        appId: "figma",
        name: "Brand_Kit_2026.fig",
        frames: [{ name: "Cover", width: 1920, height: 1080 }],
      },
    ],
    formats: SOCIAL_FORMATS,
    layers: ["Background", "Product shot", "Headline", "Subline", "Logo", "CTA button", "Legal"],
    findings: { "format-x-header": "overset" },
  });
}
