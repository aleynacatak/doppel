// Regenerates the synthetic eval fixtures (plain PNGs drawn in code): node evals/make-fixtures.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const here = path.dirname(new URL(import.meta.url).pathname);
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, body) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
};
/** An RGB PNG from a color function. */
function png(file, w, h, color) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(color(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
/** A JPEG, drawn as a PNG and converted by macOS's sips. */
function jpg(file, w, h, color) {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "doppl-fixture-")), "image.png");
  png(tmp, w, h, color);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("sips", ["-s", "format", "jpeg", tmp, "--out", file], { stdio: "ignore" });
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
}
const WHITE = [255, 255, 255];
const d = (x, y, cx, cy) => Math.hypot(x - cx, y - cy);

// Products on a plain white background.
const cut = path.join(here, "tasks/ps-cutout-white-bg/fixtures/images");
png(path.join(cut, "orange.png"), 360, 240, (x, y) => (d(x, y, 230, 110) <= 6 ? WHITE : d(x, y, 180, 120) <= 80 ? [230, 120, 30] : WHITE));
png(path.join(cut, "box.png"), 360, 240, (x, y) => (x >= 100 && x < 260 && y >= 65 && y < 175 ? [40, 140, 70] : WHITE));
png(path.join(cut, "ring.png"), 360, 240, (x, y) => (d(x, y, 180, 120) >= 35 && d(x, y, 180, 120) <= 90 ? [40, 80, 200] : WHITE));

// Images to resize: a gradient and stripes.
const rs = path.join(here, "tasks/ps-resize-jpg/fixtures/images");
png(path.join(rs, "gradient.png"), 600, 400, (x, y) => [Math.round((x / 600) * 255), Math.round((y / 400) * 255), 140]);
png(path.join(rs, "stripes.png"), 900, 300, (x) => (Math.floor(x / 30) % 2 ? [200, 60, 60] : [250, 230, 210]));
// Flavor pictures named the way designers name files: different case, spaces, dashes, mixed formats, a stray file.
// Each is a colored circle on white, so an output's color shows which picture it got. Fig has no picture.
const FLAVORS = { "Strawberry Vanilla": [220, 60, 90], Mango: [245, 170, 30], Blueberry: [70, 80, 190] };
const circle = (rgb) => (x, y) => (d(x, y, 150, 150) <= 110 ? rgb : WHITE);
for (const task of ["ps-flavor-cards", "figma-flavor-labels-sim"]) {
  const pics = path.join(here, `tasks/${task}/fixtures/flavor pics`);
  fs.rmSync(pics, { recursive: true, force: true });
  png(path.join(pics, "Strawberry_Vanilla.PNG"), 300, 300, circle(FLAVORS["Strawberry Vanilla"]));
  jpg(path.join(pics, "mango-label.jpg"), 300, 300, circle(FLAVORS.Mango));
  jpg(path.join(pics, "BLUEBERRY.jpeg"), 300, 300, circle(FLAVORS.Blueberry));
  png(path.join(pics, "old-test.png"), 300, 300, circle([128, 128, 128]));
}
// The same pictures named exactly as the list says.
const clean = path.join(here, "tasks/figma-flavor-labels-clean-sim/fixtures/images");
fs.rmSync(clean, { recursive: true, force: true });
for (const [name, rgb] of Object.entries(FLAVORS)) png(path.join(clean, `${name.toLowerCase().replace(/ /g, "-")}.png`), 300, 300, circle(rgb));

// Product photos and, in another folder, the brand logo.
const photos = path.join(here, "tasks/ps-logo-two-folders/fixtures/photos");
fs.rmSync(photos, { recursive: true, force: true });
for (const [name, rgb] of Object.entries({ apricot: [240, 180, 120], fig: [120, 80, 110], plum: [100, 60, 130] })) jpg(path.join(photos, `${name}.jpg`), 400, 300, () => rgb);
png(path.join(here, "tasks/ps-logo-two-folders/fixtures/brand/logo.png"), 120, 120, () => [220, 30, 30]);
console.log("fixtures written");
