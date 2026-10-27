import { describe, it, expect } from "vitest";
import { BarcodeError, barcodeSvg, checkDigit, validateBarcode } from "../electron/core/helpers/barcode";

// Standard tables, written out here independently of the implementation.
const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];

// Code 128 bar/space widths for the symbols the tests need.
const C128: Record<number, string> = {
  12: "112232", // "," in B / "12" in C
  33: "111323", // "A"
  34: "131123", // "B" in B / "34" in C
  35: "131321", // "C"
  36: "112313", // "D"
  56: "331121",
  94: "131141",
  99: "113141", // Code C
  100: "114131", // Code B
  104: "211214", // Start B
  105: "211232", // Start C
};
const STOP = "1100011101011"; // 2331112

const widths = (w: string) => [...w].map((n, i) => (i % 2 === 0 ? "1" : "0").repeat(Number(n))).join("");
const symbols = (modules: string) => {
  const out: string[] = [];
  for (let i = 0; i + 11 <= modules.length - 13; i += 11) out.push(modules.slice(i, i + 11));
  return out;
};
const barRuns = (modules: string) => modules.match(/1+/g)?.length ?? 0;
const rectCount = (svg: string) => svg.match(/<rect /g)?.length ?? 0;

describe("checkDigit", () => {
  it("matches known GTINs", () => {
    expect(checkDigit("400638133393")).toBe(1);
    expect(checkDigit("590123412345")).toBe(7);
    expect(checkDigit("978030640615")).toBe(7);
    expect(checkDigit("9638507")).toBe(4);
    expect(checkDigit("03600029145")).toBe(2);
  });

  it("rejects non-digits", () => {
    expect(() => checkDigit("12a")).toThrow(BarcodeError);
  });
});

describe("validateBarcode", () => {
  it("accepts full codes and adds missing check digits", () => {
    expect(validateBarcode("ean13", "4006381333931")).toEqual({ ok: true, value: "4006381333931" });
    expect(validateBarcode("ean13", "590123412345")).toEqual({ ok: true, value: "5901234123457" });
    expect(validateBarcode("ean13", 9780306406157)).toEqual({ ok: true, value: "9780306406157" });
    expect(validateBarcode("ean8", "9638507")).toEqual({ ok: true, value: "96385074" });
    expect(validateBarcode("upca", " 036000291452 ")).toEqual({ ok: true, value: "036000291452" });
    expect(validateBarcode("upca", "03600029145")).toEqual({ ok: true, value: "036000291452" });
  });

  it("rejects bad values with the right code", () => {
    const code = (r: ReturnType<typeof validateBarcode>) => (r.ok ? "ok" : r.code);
    expect(code(validateBarcode("ean13", "4006381333932"))).toBe("invalid_check_digit");
    expect(code(validateBarcode("ean8", "96385075"))).toBe("invalid_check_digit");
    expect(code(validateBarcode("ean13", "40063813339"))).toBe("invalid_length");
    expect(code(validateBarcode("upca", "0360002914520"))).toBe("invalid_length");
    expect(code(validateBarcode("ean13", "40063813339A1"))).toBe("invalid_characters");
    expect(code(validateBarcode("ean13", "   "))).toBe("empty");
    expect(code(validateBarcode("code128", ""))).toBe("empty");
    expect(code(validateBarcode("code128", "café"))).toBe("invalid_characters");
    expect(code(validateBarcode("code128", "x".repeat(81)))).toBe("invalid_length");
  });

  it("explains the problem in plain words", () => {
    const r = validateBarcode("ean13", "4006381333932");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe("The last digit of this EAN-13 barcode should be 1, not 2. Check the number for a typo.");
  });

  it("barcodeSvg throws BarcodeError with the code", () => {
    try {
      barcodeSvg("ean13", "123");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BarcodeError);
      expect((err as BarcodeError).code).toBe("invalid_length");
    }
  });
});

describe("EAN / UPC encoding", () => {
  it("EAN-13 has 95 modules with start, center and end guards", () => {
    const { modules, value } = barcodeSvg("ean13", "590123412345");
    expect(value).toBe("5901234123457");
    expect(modules).toHaveLength(95);
    expect(modules.slice(0, 3)).toBe("101");
    expect(modules.slice(45, 50)).toBe("01010");
    expect(modules.slice(92)).toBe("101");
  });

  it("EAN-13 left half follows the parity of the first digit", () => {
    // First digit 5 → LGGLLG
    const { modules } = barcodeSvg("ean13", "5901234123457");
    const left = [L[9], G[0], G[1], L[2], L[3], G[4]].join("");
    const right = [1, 2, 3, 4, 5, 7].map((d) => R[d]).join("");
    expect(modules.slice(3, 45)).toBe(left);
    expect(modules.slice(50, 92)).toBe(right);
  });

  it("EAN-8 has 67 modules", () => {
    const { modules } = barcodeSvg("ean8", "96385074");
    expect(modules).toHaveLength(67);
    expect(modules).toBe("101" + [9, 6, 3, 8].map((d) => L[d]).join("") + "01010" + [5, 0, 7, 4].map((d) => R[d]).join("") + "101");
  });

  it("UPC-A has 95 modules and matches EAN-13 with a leading 0", () => {
    const upc = barcodeSvg("upca", "036000291452");
    expect(upc.modules).toHaveLength(95);
    expect(upc.modules).toBe(barcodeSvg("ean13", "0036000291452").modules);
  });

  it("prints EAN-13 digits like a retail barcode", () => {
    const { svg } = barcodeSvg("ean13", "5901234123457");
    const digits = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    expect(digits).toEqual([..."5901234123457"]);
    // The first digit sits left of the start guard (bars start at 11 modules × 2 px = 22).
    const firstX = Number(svg.match(/<text x="([\d.]+)"/)![1]);
    expect(firstX).toBeLessThan(22);
  });

  it("extends the guard bars below the others only when text is shown", () => {
    const withText = barcodeSvg("ean13", "5901234123457", { background: null });
    const heights = new Set([...withText.svg.matchAll(/<rect [^>]*height="([\d.]+)"/g)].map((m) => m[1]));
    expect([...heights].sort()).toEqual(["80", "90"]);
    const noText = barcodeSvg("ean13", "5901234123457", { background: null, showText: false });
    expect(noText.svg).not.toContain("<text");
    expect(noText.height).toBe(80);
    expect(new Set([...noText.svg.matchAll(/<rect [^>]*height="([\d.]+)"/g)].map((m) => m[1]))).toEqual(new Set(["80"]));
  });
});

describe("Code 128", () => {
  it("uses code set C for an even run of digits", () => {
    const { modules } = barcodeSvg("code128", "123456");
    // Start C, 12, 34, 56, checksum
    expect(modules).toHaveLength(11 * 5 + 13);
    expect(modules.slice(0, 11)).toBe(widths(C128[105]));
    expect(modules.slice(11, 22)).toBe(widths(C128[12]));
    expect(modules.slice(-13)).toBe(STOP);
  });

  it("switches code sets for mixed input and computes the checksum", () => {
    const { modules } = barcodeSvg("code128", "AB123456CD");
    // Start B, A, B, Code C, 12, 34, 56, Code B, C, D, checksum
    // Checksum = (104 + 33×1 + 34×2 + 99×3 + 12×4 + 34×5 + 56×6 + 100×7 + 35×8 + 36×9) mod 103
    //          = (104 + 33 + 68 + 297 + 48 + 170 + 336 + 700 + 280 + 324) mod 103
    //          = 2360 mod 103 = 2360 − 22×103 = 94
    expect(modules).toHaveLength(11 * 11 + 13);
    // Value 34 is "B" in set B and "34" in set C: same pattern.
    const expected = [104, 33, 34, 99, 12, 34, 56, 100, 35, 36, 94];
    expect(symbols(modules)).toEqual(expected.map((v) => widths(C128[v])));
    expect(modules.slice(-13)).toBe(STOP);
  });

  it("uses set B for plain text", () => {
    const { modules } = barcodeSvg("code128", "AB");
    // Start B, A, B, checksum: (104 + 33×1 + 34×2) mod 103 = 205 mod 103 = 102
    expect(modules).toHaveLength(11 * 4 + 13);
    expect(modules.slice(0, 11)).toBe(widths(C128[104]));
  });

  it("has every symbol 11 modules wide, starting with a bar and ending with a space", () => {
    const { modules } = barcodeSvg("code128", "Doppl-2026 test\tline");
    expect((modules.length - 13) % 11).toBe(0);
    for (const s of symbols(modules)) {
      expect(s[0]).toBe("1");
      expect(s[10]).toBe("0");
    }
  });
});

describe("SVG output", () => {
  it("is a standalone SVG with one rect per bar run", () => {
    const r = barcodeSvg("ean13", "4006381333931", { background: null });
    expect(r.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(r.svg.endsWith("</svg>")).toBe(true);
    expect(r.svg).toContain(`viewBox="0 0 ${r.width} ${r.height}"`);
    expect(rectCount(r.svg)).toBe(barRuns(r.modules));
    // 11 + 95 + 11 modules at 2 px
    expect(r.width).toBe(234);

    const withBackground = barcodeSvg("code128", "Doppl", { moduleWidth: 1.5 });
    expect(rectCount(withBackground.svg)).toBe(barRuns(withBackground.modules) + 1);
    expect(withBackground.svg).toContain('fill="#ffffff"');
  });

  it("keeps coordinates to at most 2 decimals", () => {
    const { svg } = barcodeSvg("upca", "036000291452", { moduleWidth: 1.333 });
    const numbers = [...svg.matchAll(/\s(?:x|y|width|height|font-size)="([^"]+)"/g)].map((m) => m[1]);
    for (const n of numbers) expect(n).toMatch(/^\d+(\.\d{1,2})?$/);
  });

  it("escapes text and attributes", () => {
    const { svg } = barcodeSvg("code128", 'a<&>"b', { fontFamily: '"Open Sans", sans-serif' });
    expect(svg).toContain(">a&lt;&amp;&gt;&quot;b</text>");
    expect(svg).toContain('font-family="&quot;Open Sans&quot;, sans-serif"');
    expect(svg).not.toMatch(/<text[^>]*>[^<]*[&](?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it("prints control characters as spaces", () => {
    const { svg } = barcodeSvg("code128", "A\tB");
    expect(svg).toContain(">A B</text>");
  });
});
