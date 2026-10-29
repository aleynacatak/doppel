import fs from "node:fs/promises";
import path from "node:path";
import type { PortDef } from "../core/types";
import { type DecodedImage, readImage } from "./images";
import type { CheckDef } from "./tasks";

// Deterministic checks on a rerun of the saved routine. The model names the routine's ports, so a check's "port"
// is matched loosely: the key, then the label, then the file type it asks for, then the only file output.

export interface CheckSubject {
  /** The routine's outputs. */
  ports: PortDef[];
  /** Files per output key. */
  files: Record<string, string[]>;
  /** Text an app reported per output key (labels, details: Figma texts, text layers). */
  texts: Record<string, string[]>;
  /** The task's attachments: their files, and data rows for data files. */
  inputs: Record<string, { files: string[]; rows: number }>;
  run: { status: string; errors: string[] };
}

export interface CheckResult {
  check: CheckDef;
  passed: boolean;
  detail: string;
}

const TEXT_FILES = new Set([".txt", ".csv", ".json", ".svg", ".xml", ".html", ".md", ".jsx"]);
const stem = (file: string) => path.basename(file).replace(/\.[^.]+$/, "");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The output key a check means, or null. */
export function resolvePort(name: string, ports: PortDef[], ext?: string): string | null {
  const n = norm(name);
  const files = ports.filter((p) => p.type === "fileList" || p.type === "file");
  const singular = n.replace(/s$/, "");
  const byExt = (e: string) => files.filter((p) => p.extensions?.map((x) => x.toLowerCase()).includes(e));
  return (
    ports.find((p) => p.key === name)?.key ??
    ports.find((p) => norm(p.key) === n || norm(p.label) === n)?.key ??
    ports.find((p) => norm(p.key).includes(singular) || norm(p.label).includes(singular))?.key ??
    (ext && byExt(ext).length === 1 ? byExt(ext)[0].key : null) ??
    (byExt(singular).length === 1 ? byExt(singular)[0].key : null) ??
    (files.length === 1 ? files[0].key : null)
  );
}

function expected(value: number | string, inputs: CheckSubject["inputs"]): number | null {
  if (typeof value === "number") return value;
  const m = /^inputCount:(.+)$/.exec(value);
  if (!m) return Number.isFinite(Number(value)) ? Number(value) : null;
  const input = inputs[m[1]];
  if (!input) return null;
  return input.rows > 0 ? input.rows : input.files.length;
}

/** A grid of about 64 × 64 pixels, last row and column included: enough to find transparency quickly. */
function samples(img: DecodedImage): [number, number][] {
  const out: [number, number][] = [];
  const sx = Math.max(1, Math.floor(img.width / 64));
  const sy = Math.max(1, Math.floor(img.height / 64));
  const xs = [...Array.from({ length: Math.ceil(img.width / sx) }, (_, i) => i * sx), img.width - 1];
  const ys = [...Array.from({ length: Math.ceil(img.height / sy) }, (_, i) => i * sy), img.height - 1];
  for (const y of ys) for (const x of xs) out.push([x, y]);
  return out;
}

async function each(files: string[], test: (file: string, img: DecodedImage) => string | null, read: (f: string) => Promise<DecodedImage>): Promise<string | null> {
  for (const file of files) {
    let img: DecodedImage;
    try {
      img = await read(file);
    } catch (err) {
      return `${path.basename(file)}: ${(err as Error).message}`;
    }
    const problem = test(file, img);
    if (problem) return `${path.basename(file)}: ${problem}`;
  }
  return null;
}

export async function runChecks(checks: CheckDef[], s: CheckSubject, read: (file: string) => Promise<DecodedImage> = readImage): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    const result = (passed: boolean, detail: string) => results.push({ check, passed, detail });
    if (check.type === "noRunErrors") {
      result(s.run.status === "succeeded" && s.run.errors.length === 0, s.run.errors.length ? s.run.errors.slice(0, 3).join(" | ") : `run ${s.run.status}`);
      continue;
    }
    if (check.type === "textContains") {
      const keys = check.port ? [resolvePort(check.port, s.ports)].filter((k): k is string => !!k) : Object.keys({ ...s.files, ...s.texts });
      const haystack = keys.flatMap((k) => s.texts[k] ?? []);
      for (const k of keys) {
        for (const f of s.files[k] ?? []) if (TEXT_FILES.has(path.extname(f).toLowerCase())) haystack.push(await fs.readFile(f, "utf8").catch(() => ""));
      }
      const found = haystack.some((t) => t.includes(check.text));
      result(found, found ? `found "${check.text}"` : `"${check.text}" not in ${haystack.length} texts`);
      continue;
    }
    const ext = check.type === "fileExtension" ? check.is.replace(/^\./, "").toLowerCase() : undefined;
    const key = resolvePort(check.port, s.ports, ext);
    if (!key) {
      result(false, `no output like "${check.port}" (outputs: ${s.ports.map((p) => p.key).join(", ") || "none"})`);
      continue;
    }
    const files = s.files[key] ?? [];
    switch (check.type) {
      case "outputCount": {
        const want = expected(check.equals, s.inputs);
        result(want !== null && files.length === want, `${files.length} files in "${key}", expected ${want ?? check.equals}`);
        break;
      }
      case "fileExtension": {
        const wrong = files.filter((f) => path.extname(f).slice(1).toLowerCase() !== ext);
        result(files.length > 0 && wrong.length === 0, files.length === 0 ? `no files in "${key}"` : wrong.length ? `${wrong.map((f) => path.basename(f)).join(", ")} aren't .${ext}` : `all .${ext}`);
        break;
      }
      case "imageSize": {
        const tol = check.tolerance ?? 1;
        const sources = check.scaleOf ? (s.inputs[check.scaleOf]?.files ?? []) : [];
        const sourceSize = new Map<string, DecodedImage>();
        for (const f of sources) sourceSize.set(stem(f), await read(f).catch(() => null as never));
        const problem = await each(
          files,
          (file, img) => {
            if (check.width !== undefined && Math.abs(img.width - check.width) > tol) return `width ${img.width}, expected ${check.width}`;
            if (check.height !== undefined && Math.abs(img.height - check.height) > tol) return `height ${img.height}, expected ${check.height}`;
            if (check.maxWidth !== undefined && img.width > check.maxWidth + tol) return `width ${img.width} over ${check.maxWidth}`;
            if (check.maxHeight !== undefined && img.height > check.maxHeight + tol) return `height ${img.height} over ${check.maxHeight}`;
            if (check.scaleOf && check.scale) {
              const src = sourceSize.get(stem(file));
              if (!src) return `no input named ${stem(file)} to compare with`;
              const want = Math.round(src.width * check.scale);
              if (Math.abs(img.width - want) > tol) return `width ${img.width}, expected ${want} (${check.scale} × ${src.width})`;
            }
            return null;
          },
          read,
        );
        result(files.length > 0 && !problem, files.length === 0 ? `no files in "${key}"` : (problem ?? `${files.length} images fit`));
        break;
      }
      case "hasTransparency": {
        const problem = await each(
          files,
          (_f, img) => (!img.alpha || !img.pixel ? "no alpha channel" : samples(img).some(([x, y]) => img.pixel!(x, y)[3] < 255) ? null : "no transparent pixels"),
          read,
        );
        result(files.length > 0 && !problem, files.length === 0 ? `no files in "${key}"` : (problem ?? "transparent areas in every file"));
        break;
      }
      case "cornerPixelsTransparent": {
        const problem = await each(
          files,
          (_f, img) => {
            if (!img.pixel) return "can't read pixels (not a PNG)";
            const corners: [number, number][] = [[0, 0], [img.width - 1, 0], [0, img.height - 1], [img.width - 1, img.height - 1]];
            const opaque = corners.filter(([x, y]) => img.pixel!(x, y)[3] > 16);
            return opaque.length ? `${opaque.length} corner(s) not transparent` : null;
          },
          read,
        );
        result(files.length > 0 && !problem, files.length === 0 ? `no files in "${key}"` : (problem ?? "corners transparent"));
        break;
      }
      case "noOpaqueWhite": {
        const max = check.maxShare ?? 0.02;
        const problem = await each(
          files,
          (_f, img) => {
            if (!img.pixel) return "can't read pixels (not a PNG)";
            let white = 0;
            for (let y = 0; y < img.height; y++)
              for (let x = 0; x < img.width; x++) {
                const [r, g, b, a] = img.pixel(x, y);
                if (a > 200 && r > 235 && g > 235 && b > 235) white++;
              }
            const share = white / (img.width * img.height);
            return share > max ? `${(share * 100).toFixed(1)}% of the pixels are opaque white (background left, e.g. inside enclosed areas)` : null;
          },
          read,
        );
        result(files.length > 0 && !problem, files.length === 0 ? `no files in "${key}"` : (problem ?? "no white background left"));
        break;
      }
      case "outerWhiteRemoved": {
        const max = check.maxShare ?? 0.01;
        const problem = await each(
          files,
          (_f, img) => {
            if (!img.pixel) return "can't read pixels (not a PNG)";
            const { width: w, height: h } = img;
            const white = (x: number, y: number) => {
              const [r, g, b, a] = img.pixel!(x, y);
              return a > 200 && r > 235 && g > 235 && b > 235;
            };
            // Opaque white reachable from the edges through opaque white: the background around the subject.
            const seen = new Uint8Array(w * h);
            const stack: number[] = [];
            const push = (x: number, y: number) => {
              if (x < 0 || y < 0 || x >= w || y >= h || seen[y * w + x]) return;
              seen[y * w + x] = 1;
              if (white(x, y)) stack.push(y * w + x);
            };
            for (let x = 0; x < w; x++) push(x, 0), push(x, h - 1);
            for (let y = 0; y < h; y++) push(0, y), push(w - 1, y);
            let outer = 0;
            while (stack.length) {
              const i = stack.pop()!;
              outer++;
              const x = i % w;
              const y = (i - x) / w;
              push(x + 1, y), push(x - 1, y), push(x, y + 1), push(x, y - 1);
            }
            const share = outer / (w * h);
            return share > max ? `${(share * 100).toFixed(1)}% of the pixels are opaque white around the subject (background not removed)` : null;
          },
          read,
        );
        result(files.length > 0 && !problem, files.length === 0 ? `no files in "${key}"` : (problem ?? "white around the subject removed"));
        break;
      }
      case "fileNamePattern": {
        const re = check.pattern ? new RegExp(check.pattern) : null;
        const stems = check.stemsFrom ? new Set((s.inputs[check.stemsFrom]?.files ?? []).map(stem)) : null;
        const wrong = files.filter((f) => (re && !re.test(path.basename(f))) || (stems && !stems.has(stem(f))));
        result(files.length > 0 && wrong.length === 0, files.length === 0 ? `no files in "${key}"` : wrong.length ? `${wrong.map((f) => path.basename(f)).join(", ")} don't match` : "names match");
        break;
      }
    }
  }
  return results;
}
