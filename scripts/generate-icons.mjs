// Rasterize the master monogram SVGs into the PNG icon set the PWA needs.
//
//   pnpm icons        (alias for: node scripts/generate-icons.mjs)
//
// Source of truth: public/icons/icon.svg (rounded tile) and
// public/icons/icon-maskable.svg (full-bleed, for Android maskable + iOS
// apple-touch where transparent corners must be avoided). Edit those, re-run.
//
// Uses `sharp` (libvips bundles an SVG rasterizer). Outputs are committed so
// production never has to rasterize at build/runtime.

import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const iconsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const std = readFileSync(path.join(iconsDir, 'icon.svg'));
const maskable = readFileSync(path.join(iconsDir, 'icon-maskable.svg'));

// density high enough that any resize stays crisp (master viewBox is 512).
const render = (svg, size) => sharp(svg, { density: 512 }).resize(size, size).png();

const targets = [
  // [source svg, output filename, size px]
  [std, 'icon-192.png', 192],          // manifest "any"
  [std, 'icon-512.png', 512],          // manifest "any"
  [maskable, 'icon-maskable-512.png', 512], // manifest "maskable"
  [maskable, 'apple-touch-icon.png', 180],  // iOS home screen (full-bleed, no transparent corners)
  [std, 'favicon-32.png', 32],         // small favicon fallback
];

for (const [svg, name, size] of targets) {
  await render(svg, size).toFile(path.join(iconsDir, name));
  console.log(`generated public/icons/${name} (${size}x${size})`);
}

console.log('Done. Icon set written to public/icons/.');
