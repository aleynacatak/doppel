import { figmaCatalogJsonSchema } from "../../shared/figmaActions";

/** How Figma stages work, for the model. The action catalog follows as JSON Schema (see capabilityManifest). */
export const FIGMA_MODEL_GUIDE = `Figma stages are ACTION LISTS, not code: { "actions": [ { "action": "...", ... }, ... ] }.
Doppl's plugin runs them in order with a fixed interpreter. Only the actions in the catalog exist.

Node references (fields named node, nodes, container, targetParent, within, boundary, templateChild):
- a layer name ("Card") or a path of names ("Card/Header/Title"), searched on the stage's page;
- "page:<page name>" or "page:<page name>/<path>";
- a node id ("12:34") from the inspection results;
- "$<id>" = the result of an earlier action that has "id": "<id>" (a list result counts as all its nodes);
- "$<id>.#<name>" = the descendant named <name> inside that result, chainable ("$card.#header.#title"), or
  "$<id>/<path>" for a path of child names. This is how one action list works on every copy it makes.

Placeholders (Doppl replaces them before the plugin sees the actions):
- {{params.<key>}}; a dataFile param also has {{params.<key>.rows}} and {{params.<key>.columns}}; a folder param
  has {{params.<key>.files}} (its files as items).
- {{item.<field>}} inside a repeated stage (one run per data row, or per file: fields path, name, stem, ext),
  {{itemIndex}} (1-based).
- {{stage.<stageId>.outputs.<key>}} = an earlier stage's output list.
A value that is exactly one placeholder keeps its type (numbers, lists); inside longer text it becomes text.

Rules:
- Never copy literal data from the sample rows or file names into the actions; always use placeholders.
- Never use absolute paths; image files come from {{item.path}}, {{params.<folder>}} + a name, or earlier stages.
- setText loads fonts itself. Images: setImageFill with { "folder": "{{params.images}}", "name": "{{item.image}}" },
  { "file": "..." }, or a file from an earlier stage by name: { "files": "{{stage.s1.outputs.files}}", "name": "{{item.image}}" }.
- Style words from a data column with setTextStyleRanges ranges [{ "matchAny": "{{item.allergens}}", "wholeWord": true }]
  (split by "," unless you give "separator").
- Remove a placeholder fill with setProperties { "fills": [] }. Barcodes: placeSvg with { "barcode": { "type": "ean13", "value": "{{item.ean}}" } }
  (EAN-13, EAN-8, UPC-A, Code 128; Doppl checks the check digit).
- exportNode writes a file into the stage's working folder (default) or a folder param; give "output": "<key>"
  (a fileList output of the stage) so later stages (e.g. Photoshop) get the files.
- Use measure on what you build so text that doesn't fit and elements outside their frame are flagged.
- Prefer duplicating a template frame the designer made (duplicateNode with "id", then edit "$id.#…"), or
  repeatChild for lists and tables in auto-layout containers.`;

export function figmaCapabilityManifest(): string {
  return `${FIGMA_MODEL_GUIDE}\n\nAction catalog (JSON Schema of { actions: [...] }):\n${JSON.stringify(figmaCatalogJsonSchema())}`;
}
