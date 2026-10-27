// What the model needs to know to write a Figma routine the Doppel plugin can run.
export const FIGMA_MODEL_GUIDE = `Figma routines are JavaScript (ES2020) that the Doppel plugin runs inside Figma's plugin sandbox.
The script you write is the BODY of async (figma, params, doppel) => { ... } — you can use await.

The routine works on the page that is open in Figma. By default Doppel first duplicates that page and runs
on the copy, so always work through doppel.page (never figma.currentPage, never switch pages).

In scope:
- figma: the Figma Plugin API. The file uses dynamic page loading: use figma.getNodeByIdAsync, never getNodeById.
- params: the values the designer picked, keyed by your param keys (folder params are absolute paths, strings).
- doppel helpers:
  doppel.page                         the page to work on (already loaded)
  doppel.frames() -> nodes            top-level frames/components/sections on doppel.page
  doppel.findFrame(name) -> node      a frame on doppel.page by exact name, or undefined
  await doppel.loadFonts(node)        load every font in node's text BEFORE changing text, resizing text or rescaling
  doppel.format(pattern, vars)        replaces {name} tokens, e.g. doppel.format("{format}_v1", { format: "story" })
  await doppel.exportNode(node, { folder: params.outputFolder, fileName, format: "PNG"|"JPG"|"SVG"|"PDF", scale })
                                      saves an export into a folder param the designer picked (no other folders)
  doppel.output({ key, label, nodeId, details? })
                                      call once per frame the routine made or changed (nodeId = frame.id); Doppel
                                      previews and checks each one (text cut off by its frame, missing fonts, blurry images)
  doppel.log(message)
- Return a small summary object, e.g. { made: 6 }.

Useful API: node.clone(), frame.rescale(scale), frame.resize(w, h), frame.resizeWithoutConstraints(w, h),
node.x / node.y, frame.children, node.findAll(fn), node.findAllWithCriteria({ types: ["TEXT"] }),
text.characters, text.fontSize (load fonts first), node.name.

Never: figma.closePlugin, figma.showUI, figma.ui, eval, new Function, figma.setCurrentPageAsync, network access,
absolute paths in the script (every location is a param), deleting anything outside the frames you made.`;
