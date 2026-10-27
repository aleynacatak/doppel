import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { AdobeBridge, type AdobeAppSpec, assembleScript, BridgeError, mapAppleScriptError, parseScriptResult, routineStartMarker, runnerScript } from "../electron/adapters/adobe/bridge";

const spec: AdobeAppSpec = {
  appId: "photoshop",
  bundleId: "com.adobe.Photoshop",
  shortName: "Photoshop",
  folderPrefix: "Adobe Photoshop",
  runCommand: "do javascript",
  library: "var DopplPS = {};",
  prologue: ["var before = 1;"],
  epilogue: ["var after = 1;"],
};

describe("shared Adobe bridge", () => {
  it("assembles one script: JSON polyfill, library, one JSON argument, { ok, data } result", () => {
    const main = `function (input) {\n${routineStartMarker}\nreturn input.a + 1;\n}`;
    const { source, routineStartLine } = assembleScript(spec, main);
    expect(source.indexOf("JSON")).toBeLessThan(source.indexOf("var DopplPS"));
    expect(source).toContain("arguments[0]");
    expect(source).toContain("  var before = 1;\n  try {");
    expect(source).toContain("  } finally {\n    var after = 1;");
    expect(source).toContain("JSON.stringify({ ok: true, data:");
    expect(source.split("\n")[routineStartLine! - 2]).toContain(routineStartMarker);
  });

  it("targets apps by bundle id with each app's run command", () => {
    expect(runnerScript(spec)).toContain('tell application id "com.adobe.Photoshop"');
    expect(runnerScript(spec)).toContain("do javascript jsxFile with arguments {jsonArgs} show debugger never");
    expect(runnerScript({ bundleId: "com.adobe.InDesign", runCommand: "do script" })).toContain("do script jsxFile language javascript with arguments {jsonArgs}");
  });

  it("maps AppleScript errors to plain states", () => {
    expect(mapAppleScriptError("execution error: Not authorized to send Apple events to Adobe Photoshop. (-1743)", "Photoshop")).toMatchObject({
      kind: "permission-denied",
      message: expect.stringContaining("System Settings → Privacy & Security → Automation"),
    });
    expect(mapAppleScriptError("execution error: Application isn't running. (-600)", "Photoshop").kind).toBe("not-running");
    expect(mapAppleScriptError("execution error: Adobe Photoshop got an error: General Photoshop error (8800)", "Photoshop")).toMatchObject({
      kind: "script",
      message: "General Photoshop error",
    });
  });

  it("reads results and maps error lines to the routine's own lines", () => {
    expect(parseScriptResult<{ n: number }>('{"ok":true,"data":{"n":2}}', "Photoshop")).toEqual({ n: 2 });
    try {
      parseScriptResult('{"ok":false,"error":"Layer \\"X\\" not found","line":42}', "Photoshop", 40);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).line).toBe(3);
      expect((err as BridgeError).message).toBe('Layer "X" not found');
    }
    expect(() => parseScriptResult("garbage", "Photoshop")).toThrow("Photoshop returned something Doppl couldn't read.");
  });

  it("passes the script file and arguments to osascript without a shell, and queues calls", async () => {
    const seen: { file: string; args: string[]; body: string }[] = [];
    const exec = ((file: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      if (file === "/usr/bin/osascript" && args[0] === "-e" && args.length === 5) {
        seen.push({ file, args, body: fs.readFileSync(args[2], "utf8") });
        setTimeout(() => cb(null, JSON.stringify({ ok: true, data: JSON.parse(args[3]).n * 2 }) + "\n", ""), 5);
      } else cb(new Error("unexpected"), "", "");
    }) as never;
    const bridge = new AdobeBridge(spec, exec);
    const [a, b] = await Promise.all([bridge.runJsx<number>("function (input) { return 1; }", { n: 2 }, 30), bridge.runJsx<number>("function (input) { return 1; }", { n: 5 }, 30)]);
    expect([a, b]).toEqual([4, 10]);
    expect(seen[0].args[4]).toBe("30");
    expect(seen[0].body.charCodeAt(0)).toBe(0xfeff);
    expect(seen[0].args[2].endsWith(".jsx")).toBe(true);
    expect(fs.existsSync(seen[0].args[2])).toBe(false);
  });

  it("turns a killed osascript into a timeout with a hint", async () => {
    const exec = ((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      const err = Object.assign(new Error("killed"), { killed: true });
      cb(err, "", "");
    }) as never;
    await expect(new AdobeBridge(spec, exec).runJsx("function () {}", {}, 7)).rejects.toThrow("Photoshop didn't finish within 7 seconds");
  });
});
