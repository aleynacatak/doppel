// Doppel plugin for Figma. Runs routines sent by the Doppel desktop app (through ui.html) inside
// Figma's plugin sandbox, previews the frames they make and checks them. A routine is the body of
// `async (figma, params, doppel) => { … }`; `doppel` (below) is the small helper API it can use.

const VERSION = 1;
figma.showUI(__html__, { width: 300, height: 190, title: "Doppel", themeColors: true });

function info() {
  let fileKey;
  try {
    fileKey = figma.fileKey;
  } catch (e) {
    fileKey = undefined;
  }
  return {
    version: VERSION,
    fileName: figma.root.name,
    fileKey,
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
    pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })),
  };
}

figma.on("currentpagechange", () => figma.ui.postMessage({ type: "info", info: info() }));

figma.ui.onmessage = async (msg) => {
  if (msg.type === "ready") {
    const code = (await figma.clientStorage.getAsync("pairingCode")) || "";
    figma.ui.postMessage({ type: "init", info: info(), code });
  } else if (msg.type === "saveCode") {
    await figma.clientStorage.setAsync("pairingCode", msg.code);
  } else if (msg.type === "request") {
    try {
      const result = await handle(msg.payload);
      figma.ui.postMessage({ type: "response", id: msg.id, ok: true, result });
    } catch (err) {
      figma.ui.postMessage({ type: "response", id: msg.id, ok: false, error: String((err && err.message) || err) });
    }
  }
};

async function handle(payload) {
  switch (payload.type) {
    case "info":
      return info();
    case "run":
      return runRoutine(payload);
    case "export":
      return previewNodes(payload.nodeIds, payload.width || 640);
    case "focus":
      return focusNode(payload.nodeId);
    case "fonts":
      return availableFontFamilies();
    default:
      throw new Error("Unknown request: " + payload.type);
  }
}

// ---------- Running a routine ----------

function format(pattern, vars) {
  return String(pattern).replace(/\{(\w+)\}/g, (all, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : all));
}

function isFrameLike(node) {
  return node.type === "FRAME" || node.type === "COMPONENT" || node.type === "COMPONENT_SET" || node.type === "SECTION" || node.type === "INSTANCE";
}

function makeHelpers(page, params, outputs, log, exports) {
  return {
    page,
    params,
    format,
    log(message) {
      log.push(String(message));
    },
    output(o) {
      if (!o || !o.key) throw new Error("doppel.output needs a key");
      outputs.push({
        key: String(o.key),
        label: String(o.label || o.key),
        nodeId: o.nodeId || (o.node && o.node.id) || undefined,
        details: Array.isArray(o.details) ? o.details.map((d) => ({ label: String(d.label), value: d.value === undefined ? undefined : String(d.value) })) : undefined,
      });
    },
    findFrame(name) {
      return page.children.find((n) => isFrameLike(n) && n.name === name) || page.findOne((n) => isFrameLike(n) && n.name === name);
    },
    frames() {
      return page.children.filter(isFrameLike);
    },
    async loadFonts(node) {
      const texts = node.type === "TEXT" ? [node] : "findAllWithCriteria" in node ? node.findAllWithCriteria({ types: ["TEXT"] }) : [];
      const loaded = {};
      for (const text of texts) {
        if (text.hasMissingFont) throw new Error('"' + text.name + '" uses a font that isn\'t available on this computer.');
        const fonts = text.characters.length ? text.getRangeAllFontNames(0, text.characters.length) : text.fontName === figma.mixed ? [] : [text.fontName];
        for (const font of fonts) {
          const id = font.family + "/" + font.style;
          if (!loaded[id]) {
            loaded[id] = true;
            await figma.loadFontAsync(font);
          }
        }
      }
    },
    async exportNode(node, options) {
      const opts = options || {};
      const fmt = String(opts.format || "PNG").toUpperCase();
      const settings = fmt === "SVG" || fmt === "PDF" ? { format: fmt } : { format: fmt, constraint: { type: "SCALE", value: Number(opts.scale) || 1 } };
      const bytes = await node.exportAsync(settings);
      exports.push({ folder: opts.folder, fileName: String(opts.fileName || node.name), format: fmt, nodeId: node.id, data: figma.base64Encode(bytes) });
    },
  };
}

async function runRoutine(p) {
  const original = figma.currentPage;
  await original.loadAsync();
  let page = original;
  if (p.mode !== "original") {
    page = original.clone();
    page.name = p.mode === "trial" ? "Doppel trial · " + p.routineName : original.name + " (Doppel copy)";
    await figma.setCurrentPageAsync(page);
    await page.loadAsync();
  }
  const outputs = [];
  const log = [];
  const exports = [];
  try {
    let routine;
    try {
      routine = new Function("figma", "params", "doppel", '"use strict";\nreturn (async () => {\n' + p.script + "\n})();");
    } catch (err) {
      throw new Error("The routine's code has an error: " + ((err && err.message) || err));
    }
    figma.commitUndo();
    const result = await routine(figma, p.params || {}, makeHelpers(page, p.params || {}, outputs, log, exports));
    figma.commitUndo();
    const checked = await finishOutputs(outputs, p.previewWidth || 640);
    let summary = null;
    try {
      summary = result === undefined ? null : JSON.parse(JSON.stringify(result));
    } catch (e) {
      summary = null;
    }
    return { outputs: checked.outputs, findings: checked.findings, log, exports, result: summary, page: { id: page.id, name: page.name } };
  } finally {
    if (p.mode === "trial") {
      await figma.setCurrentPageAsync(original);
      page.remove();
    }
  }
}

async function finishOutputs(outputs, width) {
  const findings = [];
  for (const output of outputs) {
    if (!output.nodeId) continue;
    const node = await figma.getNodeByIdAsync(output.nodeId);
    if (!node || !("exportAsync" in node)) continue;
    output.preview = await previewOf(node, width);
    for (const f of await checkNode(node, output.key)) findings.push(f);
  }
  return { outputs, findings };
}

async function previewOf(node, width) {
  const w = Math.max(1, Math.min(width, Math.round(node.width || width)));
  const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "WIDTH", value: w } });
  return figma.base64Encode(bytes);
}

// ---------- Checks on each frame a routine made ----------

function outsideEdge(b, box) {
  const t = 1;
  if (b.x + b.width > box.x + box.width + t) return "right";
  if (b.x < box.x - t) return "left";
  if (b.y + b.height > box.y + box.height + t) return "bottom";
  if (b.y < box.y - t) return "top";
  return null;
}

async function checkNode(frame, key) {
  const findings = [];
  const box = frame.absoluteBoundingBox;
  if (!box || !("findAll" in frame)) return findings;
  const nodes = frame.findAll((n) => n.visible !== false).slice(0, 1000);
  for (const n of nodes) {
    if (n.type === "TEXT") {
      if (n.hasMissingFont) findings.push({ type: "font-missing", message: 'Missing font in "' + n.name + '"', outputKey: key });
      if (frame.clipsContent && n.absoluteBoundingBox) {
        const edge = outsideEdge(n.absoluteBoundingBox, box);
        if (edge) findings.push({ type: "cut-off", message: '"' + n.name + '" is cut off at the ' + edge + " edge", outputKey: key });
      }
    }
    if ("fills" in n && Array.isArray(n.fills)) {
      for (const fill of n.fills) {
        if (fill.type !== "IMAGE" || fill.visible === false || !fill.imageHash) continue;
        if (fill.scaleMode !== "FILL" && fill.scaleMode !== "FIT") continue;
        const image = figma.getImageByHash(fill.imageHash);
        if (!image) continue;
        const size = await image.getSizeAsync();
        const sx = n.width / size.width;
        const sy = n.height / size.height;
        const scale = fill.scaleMode === "FILL" ? Math.max(sx, sy) : Math.min(sx, sy);
        if (scale > 1.05) {
          findings.push({
            type: "upscaled-image",
            message: '"' + n.name + '" shows its image at ' + scale.toFixed(1) + "× its pixel size, so it looks blurry",
            outputKey: key,
            value: Math.round(scale * 100) / 100,
          });
        }
      }
    }
  }
  return findings;
}

// ---------- Other requests ----------

async function previewNodes(nodeIds, width) {
  const previews = {};
  for (const id of nodeIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (node && "exportAsync" in node) previews[id] = await previewOf(node, width);
  }
  return previews;
}

async function focusNode(nodeId) {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("That frame isn't in this file anymore.");
  let page = node;
  while (page && page.type !== "PAGE") page = page.parent;
  if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
  figma.viewport.scrollAndZoomIntoView([node]);
  if (page) page.selection = [node];
  return true;
}

async function availableFontFamilies() {
  const fonts = await figma.listAvailableFontsAsync();
  const families = {};
  for (const f of fonts) families[f.fontName.family] = true;
  return Object.keys(families);
}
