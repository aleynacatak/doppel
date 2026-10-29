import { describe, expect, it } from "vitest";
import { topoOrder, wouldCreateCycle, layoutLeftToRight } from "../electron/shared/flowGraph";
import { acceptedByOutput, compatible, countLabel, describeSpec, inputSpec, normalizeExtensions, outputSpec, typeTag } from "../electron/shared/ports";
import type { PortDef } from "../electron/core/types";

const port = (type: PortDef["type"], extra: Partial<PortDef> = {}): PortDef => ({ key: "p", label: "P", type, required: true, ...extra });

describe("port type compatibility", () => {
  it("takes extension sub-types into account", () => {
    const pngs = outputSpec(port("fileList", { extensions: ["PNG"] }), false);
    expect(compatible(pngs, inputSpec(port("fileList", { extensions: ["png", "jpg"] }))).ok).toBe(true);
    const psds = outputSpec(port("fileList", { extensions: ["psd"] }), false);
    const res = compatible(psds, inputSpec(port("fileList", { extensions: ["png", "jpg"] })));
    expect(res).toEqual({ ok: false, reason: "PSD files can't go into an input that takes PNG or JPG files." });
    // Mixed lists: only the extra types are named.
    expect(compatible(outputSpec(port("fileList", { extensions: ["png", "tif"] }), false), inputSpec(port("fileList", { extensions: ["png"] })))).toMatchObject({ ok: false });
  });

  it("folds extension aliases and leaves unknown types to the run", () => {
    expect(normalizeExtensions([".JPEG", "jpg", "Tiff", "*.png", "no way", 3])).toEqual(["jpg", "tif", "png"]);
    expect(compatible(outputSpec(port("fileList", { extensions: ["jpeg"] }), false), inputSpec(port("fileList", { extensions: ["jpg"] }))).ok).toBe(true);
    // Any file into a typed input: checked file by file when the flow runs.
    expect(compatible(outputSpec(port("fileList"), false), inputSpec(port("fileList", { extensions: ["png"] }))).ok).toBe(true);
  });

  it("lets one file, or a folder, feed a file list, but not the other way round", () => {
    expect(compatible(inputSpec(port("file", { extensions: ["png"] })), inputSpec(port("fileList", { extensions: ["png"] }))).ok).toBe(true);
    expect(compatible(inputSpec(port("folder")), inputSpec(port("fileList"))).ok).toBe(true);
    expect(compatible(inputSpec(port("fileList")), inputSpec(port("file"))).ok).toBe(false);
    expect(compatible(inputSpec(port("fileList")), inputSpec(port("folder"))).ok).toBe(false);
  });

  it("checks columns of rows, documents per app, and simple values", () => {
    const rows = outputSpec(port("rows", { columns: ["sku", "title"] }), false);
    expect(compatible(rows, inputSpec(port("rows", { columns: ["sku"] }))).ok).toBe(true);
    expect(compatible(rows, inputSpec(port("rows", { columns: ["sku", "photo"] })))).toEqual({ ok: false, reason: 'The rows have no "photo" column.' });
    expect(compatible(inputSpec(port("document"), "figma"), inputSpec(port("document"), "figma")).ok).toBe(true);
    expect(compatible(inputSpec(port("document"), "figma"), inputSpec(port("document"), "photoshop")).ok).toBe(false);
    expect(compatible(inputSpec(port("number")), inputSpec(port("text"))).ok).toBe(true);
    expect(compatible(inputSpec(port("text")), inputSpec(port("number"))).ok).toBe(false);
    expect(compatible(inputSpec(port("rows")), inputSpec(port("fileList"))).ok).toBe(false);
  });

  it("collects an iterating routine's outputs into lists", () => {
    expect(outputSpec(port("file", { extensions: ["png"] }), true)).toEqual({ type: "fileList", extensions: ["png"] });
    expect(outputSpec(port("text", { key: "color" }), true)).toEqual({ type: "rows", columns: ["color"] });
    expect(outputSpec(port("file", { extensions: ["png"] }), false)).toEqual({ type: "file", extensions: ["png"] });
  });

  it("saves anything but documents to a folder, and describes types plainly", () => {
    expect(acceptedByOutput({ type: "rows" }).ok).toBe(true);
    expect(acceptedByOutput({ type: "document" }).ok).toBe(false);
    expect(describeSpec({ type: "fileList", extensions: ["png", "jpg", "tif"] })).toBe("PNG, JPG or TIF files");
    expect(typeTag({ type: "fileList", extensions: ["png", "jpg"] })).toBe("fileList<png|jpg>");
    expect(countLabel({ type: "fileList", extensions: ["png"] }, 6)).toBe("6 PNG");
    expect(countLabel({ type: "rows" }, 1)).toBe("1 row");
  });
});

describe("flow graph", () => {
  const e = (from: string, to: string) => ({ from: { nodeId: from }, to: { nodeId: to } });

  it("orders nodes so every node runs after what feeds it", () => {
    const { order, cycle } = topoOrder(["out", "b", "a", "in"], [e("in", "a"), e("a", "b"), e("b", "out"), e("in", "b")]);
    expect(order).toEqual(["in", "a", "b", "out"]);
    expect(cycle).toEqual([]);
  });

  it("finds cycles and refuses edges that would close one", () => {
    const edges = [e("a", "b"), e("b", "c")];
    expect(topoOrder(["a", "b", "c"], [...edges, e("c", "a")]).cycle).toEqual(["a", "b", "c"]);
    expect(wouldCreateCycle(edges, "c", "a")).toBe(true);
    expect(wouldCreateCycle(edges, "a", "c")).toBe(false);
    expect(wouldCreateCycle(edges, "a", "a")).toBe(true);
  });

  it("lays nodes out left to right by depth", () => {
    const pos = layoutLeftToRight(["in", "a", "b", "out"], [e("in", "a"), e("a", "out"), e("in", "b")], { columnWidth: 100, rowHeight: 10 });
    expect(pos.get("in")).toEqual({ x: 0, y: 0 });
    expect(pos.get("a")).toEqual({ x: 100, y: 0 });
    expect(pos.get("b")).toEqual({ x: 100, y: 10 });
    expect(pos.get("out")).toEqual({ x: 200, y: 0 });
  });
});
