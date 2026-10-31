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

/** Words that don't tell names apart: "Fig & Walnut" is "fig-and-walnut" is "Fig Walnut". */
const FILLER = new Set(["and", "ve", "ile", "the", "of", "with", "a", "an"]);

/** A word and its plain forms: "salted" is also "salt", "berries" "berry", "peaches" "peach" (English endings). */
function forms(word: string): string[] {
  const out = [word];
  if (word.length <= 3 || /^\d+$/.test(word)) return out;
  if (word.endsWith("ies")) out.push(`${word.slice(0, -3)}y`);
  for (const end of ["s", "es", "d", "ed", "ing"]) if (word.endsWith(end) && word.length - end.length >= 3) out.push(word.slice(0, -end.length));
  return out;
}

/** The same word, written in another form ("salt" and "salted"). */
export const sameWord = (a: string, b: string) => a === b || forms(a).some((f) => forms(b).includes(f));

/** The same words in the same order, each maybe in another form ("Allergen" and "allergens"). */
export function sameWords(a: unknown, b: unknown): boolean {
  const x = nameKey(a).split(" ");
  const y = nameKey(b).split(" ");
  return x.length === y.length && x.every((w, i) => sameWord(w, y[i]));
}

/** The words of a name that tell it apart (no "and", "&"). */
export const contentWords = (value: unknown) => nameKey(value).split(" ").filter((w) => w && !FILLER.has(w));

/** Every word of `a` is in `b`, in any order and form: "Salted Caramel Pear" and "pear caramel salt". */
export const wordsWithin = (a: string[], b: string[]) => a.length > 0 && a.every((w) => b.some((x) => sameWord(w, x)));

/**
 * A name written as one word that is made of another name's words, in any order and form: "pearcaramelsalt" is
 * "Salted Caramel Pear". Every word of the other name is used; "and" may sit between them.
 */
export function squashedFrom(squashed: unknown, name: unknown): boolean {
  const s = compactKey(squashed);
  const words = contentWords(name);
  if (s.length < 4 || words.length < 2 || words.length > 8) return false;
  const pieces = words.flatMap((w, i) => forms(w).filter((f) => f.length >= 3).map((f) => ({ f, i })));
  const fillers = [...FILLER].filter((f) => f.length > 1);
  const all = (1 << words.length) - 1;
  const seen = new Set<string>();
  const walk = (pos: number, used: number): boolean => {
    if (pos === s.length) return used === all;
    const key = `${pos}:${used}`;
    if (seen.has(key)) return false;
    seen.add(key);
    for (const p of pieces) if (s.startsWith(p.f, pos) && walk(pos + p.f.length, used | (1 << p.i))) return true;
    for (const f of fillers) if (s.startsWith(f, pos) && walk(pos + f.length, used)) return true;
    return false;
  };
  return walk(0, 0);
}

/**
 * How alike two names are, for ranking candidates: shared words (in any form, or squashed into one word), then a
 * shared beginning, then one inside the other.
 */
export function likeness(nameA: string, nameB: string): number {
  // A file's extension isn't part of its name.
  const a = nameA.replace(/\.[A-Za-z0-9]{2,5}$/, "");
  const b = nameB.replace(/\.[A-Za-z0-9]{2,5}$/, "");
  const wa = contentWords(a);
  const wb = contentWords(b);
  const shared = wb.filter((w) => wa.some((x) => sameWord(w, x))).length;
  const ca = compactKey(a);
  const cb = compactKey(b);
  // Words of one name inside the other written as one word ("pearcaramelsalt" holds pear, caramel and salt).
  const inside = (words: string[], compact: string) => words.filter((w) => w.length >= 3 && forms(w).some((f) => f.length >= 3 && compact.includes(f))).length;
  const squashed = shared > 0 ? 0 : Math.max(0, ...wb.map((x) => inside(wa, x)), ...wa.map((x) => inside(wb, x)));
  let prefix = 0;
  while (prefix < ca.length && prefix < cb.length && ca[prefix] === cb[prefix]) prefix++;
  return shared * 10 + squashed * 8 + prefix + (ca && cb && (ca.includes(cb) || cb.includes(ca)) ? 5 : 0);
}

/** Candidates ordered by how alike they are to a name, the likeliest first. */
export const rankByLikeness = (name: string, candidates: string[]) => [...candidates].sort((x, y) => likeness(name, y) - likeness(name, x) || x.localeCompare(y));
