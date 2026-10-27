// Retail (EAN-13, EAN-8, UPC-A) and Code 128 barcodes, drawn as standalone SVG.
// No dependencies: the encodings follow GS1 and ISO/IEC 15417.

export type BarcodeType = "ean13" | "ean8" | "upca" | "code128";

export type BarcodeProblem = "empty" | "invalid_characters" | "invalid_length" | "invalid_check_digit";

export class BarcodeError extends Error {
  constructor(
    readonly code: BarcodeProblem,
    message: string,
  ) {
    super(message);
    this.name = "BarcodeError";
  }
}

export interface BarcodeOptions {
  /** Width of the thinnest bar in px. Default 2. */
  moduleWidth?: number;
  /** Height of the bars in px (without the text). Default 80. */
  height?: number;
  /** Blank space on each side, in modules. Default 11 for EAN-13/UPC-A, 7 for EAN-8, 10 for Code 128.
   * Widened when needed to fit the digits printed outside the bars. */
  quietZone?: number;
  /** Print the human-readable text under the bars. Default true. */
  showText?: boolean;
  /** Default "Helvetica, Arial, sans-serif". */
  fontFamily?: string;
  /** Bar and text color. Default "#000000". */
  color?: string;
  /** Default "#ffffff"; null = transparent. */
  background?: string | null;
}

export interface BarcodeResult {
  type: BarcodeType;
  /** Full normalized value, including the check digit for EAN/UPC. */
  value: string;
  /** Bar ("1") and space ("0") pattern, one character per module, without quiet zones. */
  modules: string;
  svg: string;
  width: number;
  height: number;
}

const LABEL: Record<BarcodeType, string> = { ean13: "EAN-13", ean8: "EAN-8", upca: "UPC-A", code128: "Code 128" };
const A_LABEL: Record<BarcodeType, string> = { ean13: "An EAN-13", ean8: "An EAN-8", upca: "A UPC-A", code128: "A Code 128" };

// Digits accepted without / with the check digit.
const DIGIT_COUNT: Record<"ean13" | "ean8" | "upca", number> = { ean13: 13, ean8: 8, upca: 12 };

const CODE128_MAX_LENGTH = 80;

type Validation = { ok: true; value: string } | { ok: false; code: BarcodeProblem; message: string };

/**
 * Normalizes and checks a value. EAN-13 takes 12 digits (check digit is added) or 13 (check digit verified);
 * EAN-8 takes 7 or 8; UPC-A 11 or 12. Code 128 takes ASCII 32–126 (control characters and DEL work too),
 * max 80 characters. Whitespace is trimmed (EAN/UPC also drop spaces between digits); numbers are accepted
 * and converted to strings.
 */
export function validateBarcode(type: BarcodeType, value: string | number): Validation {
  const fail = (code: BarcodeProblem, message: string): Validation => ({ ok: false, code, message });
  const label = LABEL[type];
  if (!label) throw new Error(`"${type}" isn't a supported barcode type. Use EAN-13, EAN-8, UPC-A or Code 128.`);

  // Data rows can hand us null; never turn that into the text "null".
  const raw = value === null || value === undefined ? "" : String(value);

  if (type === "code128") {
    const text = raw.trim();
    if (!text) return fail("empty", "The barcode value is empty.");
    const bad = [...text].find((c) => c.charCodeAt(0) > 127);
    if (bad) {
      return fail(
        "invalid_characters",
        `Code 128 barcodes can only contain plain letters, digits and basic symbols, but this one contains "${bad}".`,
      );
    }
    if (text.length > CODE128_MAX_LENGTH) {
      return fail(
        "invalid_length",
        `${A_LABEL[type]} barcode can hold at most ${CODE128_MAX_LENGTH} characters, but this one has ${text.length}.`,
      );
    }
    return { ok: true, value: text };
  }

  const digits = raw.replace(/\s+/g, "");
  if (!digits) return fail("empty", "The barcode value is empty.");
  const bad = digits.match(/[^0-9]/);
  if (bad) {
    return fail("invalid_characters", `${A_LABEL[type]} barcode can only contain digits, but this one contains "${bad[0]}".`);
  }
  const full = DIGIT_COUNT[type];
  if (digits.length === full - 1) return { ok: true, value: digits + checkDigit(digits) };
  if (digits.length !== full) {
    return fail(
      "invalid_length",
      `${A_LABEL[type]} barcode needs ${full - 1} or ${full} digits, but this one has ${digits.length}.`,
    );
  }
  const expected = checkDigit(digits.slice(0, -1));
  if (Number(digits[full - 1]) !== expected) {
    return fail(
      "invalid_check_digit",
      `The last digit of this ${label} barcode should be ${expected}, not ${digits[full - 1]}. Check the number for a typo.`,
    );
  }
  return { ok: true, value: digits };
}

/** GS1 mod-10 check digit for EAN/UPC data digits (weights 3 and 1, starting from the right). */
export function checkDigit(digits: string): number {
  if (!/^[0-9]+$/.test(digits)) {
    throw new BarcodeError("invalid_characters", "A check digit can only be calculated from digits.");
  }
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const weight = i % 2 === 0 ? 3 : 1;
    sum += Number(digits[digits.length - 1 - i]) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

// ---- EAN / UPC ----

const EAN_L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const EAN_R = EAN_L.map((p) => [...p].map((b) => (b === "1" ? "0" : "1")).join(""));
const EAN_G = EAN_R.map((p) => [...p].reverse().join(""));
// Which left-half digits use the G set, chosen by the first digit of an EAN-13.
const EAN13_PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];
const GUARD_SIDE = "101";
const GUARD_CENTER = "01010";

interface Label {
  text: string;
  /** Center of the text, in modules from the first bar. */
  at: number;
  small?: boolean;
}

interface Layout {
  modules: string;
  /** Modules (by index) whose bars run down into the text area. */
  long: Set<number>;
  labels: Label[];
  /** Modules of room the text needs outside the bars, left and right. */
  textOutside: [number, number];
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

function retailLayout(type: "ean13" | "ean8" | "upca", value: string): Layout {
  const d = [...value].map(Number);
  const under = (digits: number[], firstModule: number): Label[] =>
    digits.map((digit, i) => ({ text: String(digit), at: firstModule + i * 7 + 3.5 }));

  if (type === "ean8") {
    const modules =
      GUARD_SIDE + d.slice(0, 4).map((n) => EAN_L[n]).join("") + GUARD_CENTER + d.slice(4).map((n) => EAN_R[n]).join("") + GUARD_SIDE;
    return {
      modules,
      long: new Set([...range(0, 3), ...range(31, 5), ...range(64, 3)]),
      labels: [...under(d.slice(0, 4), 3), ...under(d.slice(4), 36)],
      textOutside: [0, 0],
    };
  }

  // UPC-A is an EAN-13 whose first digit is 0, so its left half always uses the L set.
  const ean = type === "upca" ? [0, ...d] : d;
  const parity = EAN13_PARITY[ean[0]];
  const left = ean.slice(1, 7).map((n, i) => (parity[i] === "G" ? EAN_G[n] : EAN_L[n])).join("");
  const right = ean.slice(7).map((n) => EAN_R[n]).join("");
  const modules = GUARD_SIDE + left + GUARD_CENTER + right + GUARD_SIDE;
  const guards = [...range(0, 3), ...range(45, 5), ...range(92, 3)];

  if (type === "upca") {
    // UPC-A prints the first and last digit outside the bars, and their bars run down like the guards.
    return {
      modules,
      long: new Set([...guards, ...range(3, 7), ...range(85, 7)]),
      labels: [
        { text: String(d[0]), at: -5, small: true },
        ...under(d.slice(1, 6), 10),
        ...under(d.slice(6, 11), 50),
        { text: String(d[11]), at: 100, small: true },
      ],
      textOutside: [9, 9],
    };
  }
  return {
    modules,
    long: new Set(guards),
    labels: [{ text: String(d[0]), at: -5 }, ...under(d.slice(1, 7), 3), ...under(d.slice(7), 50)],
    textOutside: [9, 0],
  };
}

// ---- Code 128 ----

// Bar/space widths for symbol values 0–105, then the stop pattern (106).
const CODE128_PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];
const SHIFT = 98;
const TO_C = 99;
const TO_B = 100;
const TO_A = 101;
const START: Record<CodeSet, number> = { A: 103, B: 104, C: 105 };
const STOP = 106;

type CodeSet = "A" | "B" | "C";

/** Symbol values (start, data, checksum, stop) following the ISO/IEC 15417 Annex E rules for the shortest symbol. */
function code128Values(text: string): number[] {
  const c = [...text].map((ch) => ch.charCodeAt(0));
  const isDigit = (i: number) => c[i] >= 48 && c[i] <= 57;
  const digitRun = (i: number) => {
    let n = 0;
    while (i + n < c.length && isDigit(i + n)) n++;
    return n;
  };
  // Control characters (0–31) only exist in set A, lowercase and friends (96–127) only in set B.
  const firstOfKind = (from: number, a: (code: number) => boolean, b: (code: number) => boolean) => {
    for (let j = from; j < c.length; j++) {
      if (a(c[j])) return "a";
      if (b(c[j])) return "b";
    }
    return null;
  };
  const isControl = (code: number) => code < 32;
  const isLower = (code: number) => code >= 96;
  const pickAB = (from: number): CodeSet => (firstOfKind(from, isControl, isLower) === "a" ? "A" : "B");
  const valueIn = (set: CodeSet, code: number) => (set === "A" && code < 32 ? code + 64 : code - 32);

  let set: CodeSet = (c.length === 2 && digitRun(0) === 2) || digitRun(0) >= 4 ? "C" : pickAB(0);
  const values = [START[set]];
  let i = 0;
  while (i < c.length) {
    if (set === "C") {
      if (digitRun(i) >= 2) {
        values.push((c[i] - 48) * 10 + (c[i + 1] - 48));
        i += 2;
        continue;
      }
      set = pickAB(i);
      values.push(set === "A" ? TO_A : TO_B);
      continue;
    }
    const run = digitRun(i);
    if (run >= 4) {
      // An odd run keeps its first digit in the current set so the rest pairs up.
      if (run % 2 === 1) values.push(valueIn(set, c[i++]));
      values.push(TO_C);
      set = "C";
      continue;
    }
    const code = c[i];
    if (set === "A" && isLower(code)) {
      if (firstOfKind(i + 1, isControl, isLower) === "a") values.push(SHIFT, valueIn("B", code));
      else {
        set = "B";
        values.push(TO_B, valueIn("B", code));
      }
      i++;
      continue;
    }
    if (set === "B" && isControl(code)) {
      if (firstOfKind(i + 1, isLower, isControl) === "a") values.push(SHIFT, valueIn("A", code));
      else {
        set = "A";
        values.push(TO_A, valueIn("A", code));
      }
      i++;
      continue;
    }
    values.push(valueIn(set, code));
    i++;
  }

  const checksum = values.reduce((sum, v, pos) => sum + v * Math.max(pos, 1), 0) % 103;
  values.push(checksum, STOP);
  return values;
}

function widthsToModules(widths: string): string {
  return [...widths].map((w, i) => (i % 2 === 0 ? "1" : "0").repeat(Number(w))).join("");
}

// ---- SVG ----

const DEFAULT_QUIET_ZONE: Record<BarcodeType, number> = { ean13: 11, upca: 11, ean8: 7, code128: 10 };

const num = (n: number) => String(Math.round(n * 100) / 100);

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);
}

function positive(value: number | undefined, fallback: number, what: string, allowZero = false): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new RangeError(`The barcode ${what} must be a ${allowZero ? "positive number or 0" : "positive number"}.`);
  }
  return value;
}

/** Draws a barcode as a standalone SVG. Throws BarcodeError on invalid input. */
export function barcodeSvg(type: BarcodeType, value: string | number, options: BarcodeOptions = {}): BarcodeResult {
  const checked = validateBarcode(type, value);
  if (!checked.ok) throw new BarcodeError(checked.code, checked.message);
  const normalized = checked.value;

  const mw = positive(options.moduleWidth, 2, "bar width");
  const barHeight = positive(options.height, 80, "height");
  const quietZone = positive(options.quietZone, DEFAULT_QUIET_ZONE[type], "quiet zone", true);
  const showText = options.showText ?? true;
  const font = options.fontFamily ?? "Helvetica, Arial, sans-serif";
  const color = options.color ?? "#000000";
  const background = options.background === undefined ? "#ffffff" : options.background;

  let layout: Layout;
  if (type === "code128") {
    const modules = code128Values(normalized).map((v) => widthsToModules(CODE128_PATTERNS[v])).join("");
    // Control characters can't appear in SVG text, so they print as spaces.
    const text = normalized.replace(/[\x00-\x1f\x7f]/g, " ");
    layout = { modules, long: new Set(), labels: [{ text, at: modules.length / 2 }], textOutside: [0, 0] };
  } else {
    layout = retailLayout(type, normalized);
  }

  const fontSize = 9 * mw;
  const capHeight = 0.72 * fontSize;
  const retail = type !== "code128";
  const left = Math.max(quietZone, showText ? layout.textOutside[0] : 0) * mw;
  const right = Math.max(quietZone, showText ? layout.textOutside[1] : 0) * mw;
  const width = left + layout.modules.length * mw + right;
  const textGap = retail ? mw : 2 * mw;
  const baseline = barHeight + textGap + capHeight;
  const height = showText ? baseline + (retail ? mw : 0.25 * fontSize) : barHeight;
  const longHeight = barHeight + 5 * mw;

  const bars: string[] = [];
  const m = layout.modules;
  for (let i = 0; i < m.length; ) {
    if (m[i] !== "1") {
      i++;
      continue;
    }
    const long = showText && layout.long.has(i);
    let end = i + 1;
    while (end < m.length && m[end] === "1" && (showText && layout.long.has(end)) === long) end++;
    const h = long ? longHeight : barHeight;
    bars.push(`<rect x="${num(left + i * mw)}" y="0" width="${num((end - i) * mw)}" height="${num(h)}"/>`);
    i = end;
  }

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(width)} ${num(height)}">`,
  ];
  if (background !== null) {
    parts.push(`<rect width="${num(width)}" height="${num(height)}" fill="${escapeXml(background)}"/>`);
  }
  parts.push(`<g fill="${escapeXml(color)}" shape-rendering="crispEdges">`, ...bars, "</g>");
  if (showText) {
    parts.push(`<g fill="${escapeXml(color)}" font-family="${escapeXml(font)}" text-anchor="middle">`);
    for (const label of layout.labels) {
      const size = label.small ? fontSize * 0.75 : fontSize;
      parts.push(
        `<text x="${num(left + label.at * mw)}" y="${num(baseline)}" font-size="${num(size)}">${escapeXml(label.text)}</text>`,
      );
    }
    parts.push("</g>");
  }
  parts.push("</svg>");

  return { type, value: normalized, modules: m, svg: parts.join(""), width: Math.round(width * 100) / 100, height: Math.round(height * 100) / 100 };
}
