import { MockAdapter } from "../mock/mockAdapter";

/** Stand-in for InDesign when DOPPEL_MOCK_INDESIGN=1 (e.g. designing screens on a Mac without InDesign). */
export function createIndesignMockAdapter() {
  return new MockAdapter({
    id: "indesign",
    name: "Adobe InDesign",
    scriptLanguage: "ExtendScript",
    connection: "script-bridge",
    modelGuide: "Mock InDesign adapter. Scripts are not executed.",
    version: "21.6",
    disconnectedStatus: "not-running",
    isConnected: () => true,
    setConnected: () => undefined,
    documents: [{ id: "untitled:Annual_Report_2026.indd", appId: "indesign", name: "Annual_Report_2026.indd", pageCount: 24, active: true }],
    formats: [],
    layers: ["Text", "Images", "Background", "Guides"],
    findings: {},
  });
}
