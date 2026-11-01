import fs from "node:fs/promises";
import path from "node:path";
import { encodePng } from "../../evals/images";

// Synthetic images for building block tests ("gen:<name>" inputs), drawn in code so no fixture files ship.

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const d = (x: number, y: number, cx: number, cy: number) => Math.hypot(x - cx, y - cy);

const GENERATORS: Record<string, () => Buffer> = {
  /** An orange product on white, with a small white highlight on it. */
  "product-on-white": () => encodePng(360, 240, (x, y) => (d(x, y, 230, 110) <= 6 ? WHITE : d(x, y, 180, 120) <= 80 ? [230, 120, 30, 255] : WHITE)),
  /** A blue ring on white: white around it and inside it. */
  "ring-on-white": () => encodePng(360, 240, (x, y) => (d(x, y, 180, 120) >= 35 && d(x, y, 180, 120) <= 90 ? [40, 80, 200, 255] : WHITE)),
  /** An orange product on a gray gradient: a subject with no white around it. */
  "product-on-gray": () => encodePng(360, 240, (x, y) => (d(x, y, 180, 120) <= 80 ? [Math.round(250 - d(x, y, 150, 90)), Math.round(135 - d(x, y, 150, 90) / 2), 30, 255] : [Math.round(200 - y / 5), Math.round(200 - y / 5), Math.round(200 - y / 5), 255])),
  /** A 600 × 400 gradient (no white background). */
  photo: () => encodePng(600, 400, (x, y) => [Math.round((x / 600) * 255), Math.round((y / 400) * 255), 140, 255]),
  /** A blank white image: Select Subject finds nothing in it. */
  "blank-white": () => encodePng(200, 120, () => WHITE),
  /** A solid red image (#E02020). */
  red: () => encodePng(200, 120, () => [224, 32, 32, 255]),
};

export const FIXTURE_NAMES = Object.keys(GENERATORS);

/** The path of an input: a generated fixture (written once into dir), or a file path as it is. */
export async function fixturePath(input: string, dir: string): Promise<string> {
  if (!input.startsWith("gen:")) return input;
  const name = input.slice(4);
  const make = GENERATORS[name];
  if (!make) throw new Error(`No fixture "${name}" (fixtures: ${FIXTURE_NAMES.join(", ")}).`);
  const file = path.join(dir, `${name}.png`);
  try {
    await fs.access(file);
  } catch {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, make());
  }
  return file;
}
