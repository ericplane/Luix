// Render the SVG to the Marketplace's required 128x128 PNG.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const svgPath = resolve(repoRoot, "assets/icon.svg");
const pngPath = resolve(repoRoot, "assets/icon.png");

const svg = readFileSync(svgPath);

const png = await sharp(svg, { density: 384 })
  .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9 })
  .toBuffer();

writeFileSync(pngPath, png);

console.log(`✓ wrote ${pngPath} (${png.length} bytes)`);
