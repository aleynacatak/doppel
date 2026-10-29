// Names as people mean them, for comparing file names, column names and values. Only for comparing: the names
// themselves (on disk, in the file, in the data) are never changed.

/**
 * "Strawberry_Vanilla", "strawberry-vanilla", "StrawberryVanilla" and "Strawberry Vanilla" are the same name; so
 * are "Çilek" and "cilek", and "jar01" and "Jar 01". Accents go (whether the name is stored composed, as in a CSV,
 * or decomposed, as macOS stores file names), Turkish ı is i, and words split at anything but letters and digits.
 */
export function nameKey(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/(?<=\p{Ll})(?=\p{Lu})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/gu, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The name with no spaces at all: "strawberryvanilla" is "Strawberry Vanilla". */
export const compactKey = (value: unknown) => nameKey(value).replace(/ /g, "");

/** Words people add to file names that don't change what the file is: "mango final", "mango copy", "mango (2)", "mango v3". */
const NOISE = new Set(["final", "copy", "kopya", "edit", "edited", "new", "yeni", "son", "latest"]);

/** The name without trailing noise words, version numbers or Finder's copy numbers ("Mango (2)", "mango_v3_final"). */
export function coreKey(value: unknown): string {
  const words = nameKey(String(value ?? "").replace(/\(\d+\)\s*$/, "")).split(" ").filter(Boolean);
  while (words.length > 1) {
    const last = words[words.length - 1];
    const prev = words[words.length - 2];
    if (NOISE.has(last)) words.pop();
    else if (/^\d+$/.test(last) && prev === "v") words.splice(-2, 2);
    else break;
  }
  return words.join(" ");
}
