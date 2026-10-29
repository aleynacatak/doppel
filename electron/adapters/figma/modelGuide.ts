import { figmaCatalogJsonSchema } from "../../shared/figmaActions";

/** How Figma routines work, for the model. The action catalog follows as JSON Schema (see capabilityManifest). */
export const FIGMA_MODEL_GUIDE = `Figma routines are ACTION LISTS, not code: { "actions": [ { "action": "...", ... }, ... ] }.
Doppl's plugin runs them in order with a fixed interpreter. Only the actions in the catalog exist.

Node references (fields named node, nodes, container, targetParent, within, boundary, templateChild):
- a layer name ("Card") or a path of names ("Card/Header/Title"), searched on the page the routine runs on;
- "page:<page name>" or "page:<page name>/<path>";
- a node id ("12:34") from the inspection results;
- "$<id>" = the result of an earlier action that has "id": "<id>" (a list result counts as all its nodes);
- "$<id>.#<name>" = the descendant named <name> inside that result, chainable ("$card.#header.#title"), or
  "$<id>/<path>" for a path of child names. This is how one action list works on every copy it makes.

Placeholders (Doppl replaces them before the plugin sees the actions):
- {{inputs.<key>}}: an input's value. A file input is its path (and has .name, .stem, .ext); a fileList input is
  the list of paths; a rows input has {{inputs.<key>.rows}} and {{inputs.<key>.columns}}; a folder input is its
  path and has {{inputs.<key>.files}}.
- {{settings.<key>}}: a setting's value.
- In a routine that iterates: {{item.<field>}} (a data row's column, or for files path, name, stem, ext),
  {{itemIndex}} (1-based), and {{matched.<input>}}: the item of a second list input that pairs with this item
  (Doppl pairs them, e.g. the image named in the row); a matched file is its path, with .name, .stem, .ext.
A value that is exactly one placeholder keeps its type (numbers, lists); inside longer text it becomes text.

Rules:
- Never copy literal data from the sample rows or file names into the actions; always use placeholders.
- Never use absolute paths; image files come from inputs: {{item}}, {{matched.<input>}}, a file input, or a list.
- setText loads fonts itself. Images: setImageFill with { "file": "{{matched.photos}}" } (the paired file),
  { "file": "{{item.path}}" }, { "folder": "{{inputs.images}}", "name": "{{item.image}}" }, or a file from a
  list by name: { "files": "{{inputs.cutouts}}", "name": "{{item.image}}" }.
- Style words from a data column with setTextStyleRanges ranges [{ "matchAny": "{{item.allergens}}", "wholeWord": true }]
  (split by "," unless you give "separator").
- Remove a placeholder fill with setProperties { "fills": [] }. Barcodes: placeSvg with { "barcode": { "type": "ean13", "value": "{{item.ean}}" } }
  (EAN-13, EAN-8, UPC-A, Code 128; Doppl checks the check digit).
- exportNode writes a file into the routine's working folder; give "output": "<key>" (one of the routine's
  file or fileList outputs). Doppl hands the files to the next routine, or saves them where the designer picks.
- Use measure on what you build so text that doesn't fit and elements outside their frame are flagged.
- Prefer duplicating a template frame the designer made (duplicateNode with "id", then edit "$id.#…"), or
  repeatChild for lists and tables in auto-layout containers.`;

export function figmaCapabilityManifest(): string {
  return `${FIGMA_MODEL_GUIDE}\n\nAction catalog (JSON Schema of { actions: [...] }):\n${JSON.stringify(figmaCatalogJsonSchema())}`;
}
