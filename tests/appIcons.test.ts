import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ nativeImage: {} }));

import { preferredApp } from "../electron/core/services/appIcons";

describe("which copy of an app gives the logo", () => {
  it("takes the newest year, reading numbers as numbers", () => {
    expect(preferredApp(["/Applications/Adobe Photoshop 2025/Adobe Photoshop 2025.app", "/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app"])).toBe(
      "/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app",
    );
    expect(preferredApp(["/Applications/App 9.app", "/Applications/App 10.app"])).toBe("/Applications/App 10.app");
  });

  it("prefers the Applications folder over a stray copy", () => {
    expect(preferredApp(["/Users/me/Downloads/Figma 2.app", "/Applications/Figma.app"])).toBe("/Applications/Figma.app");
    expect(preferredApp(["/Users/me/Applications/Figma.app"])).toBe("/Users/me/Applications/Figma.app");
  });

  it("ignores what isn't an app, and may find nothing", () => {
    expect(preferredApp(["", "/Applications/Figma.app/Contents/Info.plist"])).toBeUndefined();
    expect(preferredApp([])).toBeUndefined();
  });
});
