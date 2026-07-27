// Recolors PrimeReact's stock `lara-{light,dark}-green` themes (emerald) into
// Sampolio's forest palette, and copies the results to public/themes/ where
// theme-provider.tsx (`/themes/sampolio-{light,dark}.css`) loads them.
//
//   node scripts/copy-themes.mjs
//
// Ordered, case-insensitive string replacements — no CSS parsing, so the
// source files' selectors/structure are preserved byte-for-byte except for
// the swapped tokens. Run via `pnpm run copy-themes` (wired into `build` and
// `postinstall`), and re-run any time the PrimeReact version changes (a new
// lara-*-green release could shift which hexes are present).
//
// Also swaps the PrimeReact-bundled `"Inter var", sans-serif` font stack for
// `var(--font-body), sans-serif` so the theme's own font declarations don't
// fight the app's Hanken Grotesk.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const SOURCE_LIGHT = path.join(ROOT, 'node_modules/primereact/resources/themes/lara-light-green/theme.css');
const SOURCE_DARK = path.join(ROOT, 'node_modules/primereact/resources/themes/lara-dark-green/theme.css');
const OUT_DIR = path.join(ROOT, 'public/themes');
const OUT_LIGHT = path.join(OUT_DIR, 'sampolio-light.css');
const OUT_DARK = path.join(OUT_DIR, 'sampolio-dark.css');

// Emerald → forest. Each entry is [needle, replacement]; needles are matched
// case-insensitively, replacement text is inserted verbatim. Order doesn't
// matter for correctness (all needles are disjoint literal strings), but is
// kept roughly darkest→lightest for readability.
const LIGHT_MAP = [
  ['#10b981', '#2F6B4F'], // --primary-color / primary-500
  ['#059669', '#285A43'], // primary-600
  ['#047857', '#1F4634'], // primary-700 (heaviest hit — hover/active states)
  ['#a7f3d0', '#C2D9CC'], // primary-100
  ['#f0fdfa', '#F2F7F4'], // primary-50
  ['rgba(16, 185, 129', 'rgba(47, 107, 79'], // primary-color rgba() variants (alpha untouched)
  ['#f3fcf9', '#F2F7F4'], // primary-50-ish highlight tint
  ['#c6eee1', '#DEEBE3'], // primary-200-ish
  ['#98e1c9', '#C2D9CC'], // primary-300-ish
  ['#6bd4b1', '#9FC3AF'], // primary-400-ish
  ['#3dc699', '#6FA58A'], // primary-500-ish (lighter hover)
  ['#0e9d6e', '#285A43'], // primary-600-ish
  ['#0b825a', '#1F4634'], // primary-700-ish
  ['#096647', '#183A2B'], // primary-800-ish
  ['#064a34', '#112A1F'], // primary-900-ish
  // Extra emerald-family hex found by grep that isn't part of the documented
  // 900-scale ramp: `.p-inline-message-success` uses this exact shade
  // (between primary-500 and primary-600 in luminance). Mapped onto the same
  // "success" target as primary-600 so success messaging stays forest-toned.
  ['#1ea97c', '#285A43'],
];

const DARK_MAP = [
  ['#34d399', '#85C5A3'],
  ['#6ee7b7', '#A3D4BA'],
  ['#a7f3d0', '#BFE0CE'],
  ['#052e16', '#0C231A'],
  ['rgba(52, 211, 153', 'rgba(133, 197, 163'],
  ['#f5fdfa', '#F1F8F4'],
  ['#cef4e7', '#D5EADF'],
  ['#a8ecd3', '#BFE0CE'],
  ['#81e4c0', '#A3D4BA'],
  ['#5bdbac', '#94CCAF'],
  ['#2cb382', '#6FAE8D'],
  ['#24946b', '#5A9377'],
  ['#1d7454', '#457861'],
  ['#15543d', '#305C4A'],
  // #030712 (on-primary text) intentionally left alone — still reads fine on
  // the new lighter forest greens.
  // Extra emerald-family hexes found by grep: `.p-inline-message-success`
  // (repeated 3x for different nesting) reuses the *light* theme's raw
  // #10b981/rgba(16,185,129,...) instead of the dark ramp's #34d399 — map
  // them onto the same target as #34d399 so dark-mode success messaging
  // stays consistent forest-on-dark.
  ['#10b981', '#85C5A3'],
  ['rgba(16, 185, 129', 'rgba(133, 197, 163'],
  // --- De-blue the dark surface ramp -----------------------------------
  // Lara's dark theme surfaces are Tailwind's blue-tinted grays (gunmetal).
  // iOS dark surfaces are neutral; ours get a barely-there green tint so
  // inputs/cards/borders/hovers stop reading "navy" next to the forest
  // accent. Same luminance as the originals — only the hue moves.
  ['#424b57', '#3F4842'], // borders / dividers (heaviest surface hit)
  ['#1f2937', '#1E2420'], // card / input / overlay surface
  ['rgba(31, 41, 55', 'rgba(30, 36, 32'],
  ['rgba(66, 75, 87', 'rgba(63, 72, 66'],
  ['#374151', '#333B35'], // hover surface
  ['#111827', '#131714'], // ground / deepest surface
  ['#1c2127', '#1A1F1B'],
  ['#1c2532', '#1E2620'],
  ['#94a3b8', '#9AA69E'], // slate muted text -> green-gray
  ['rgba(148, 163, 184', 'rgba(154, 166, 158'],
  ['#6b7280', '#6F7972'], // dim text
];

const BOTH_MAP = [
  ['"Inter var", sans-serif', 'var(--font-body), sans-serif'],
  // Leftover bare occurrences after the line above are the two @font-face
  // declarations that name (and would otherwise lazy-load) the Inter
  // variable font file. Nothing references that font-family anymore, so
  // rename it to something inert rather than leaving a dead "Inter var"
  // string in the shipped CSS (also keeps the `Inter var` sanity grep clean).
  ['"Inter var"', '"Sampolio-Unused-Inter"'],
];

/** Case-insensitive, all-occurrences literal string replace with a hit count. */
function replaceAll(source, needle, replacement) {
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let count = 0;
  const result = source.replace(re, () => {
    count += 1;
    return replacement;
  });
  return { result, count };
}

function applyMap(source, map, label) {
  let text = source;
  let total = 0;
  let failed = false;
  for (const [needle, replacement] of map) {
    const { result, count } = replaceAll(text, needle, replacement);
    text = result;
    total += count;
    console.log(`  [${label}] ${needle} -> ${replacement} : ${count} hit(s)`);
    if (count === 0) {
      console.error(`  [${label}] ERROR: expected token "${needle}" not found (0 hits)`);
      failed = true;
    }
  }
  return { text, total, failed };
}

function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let anyFailed = false;

  console.log('Light theme (lara-light-green -> sampolio-light):');
  const lightSource = fs.readFileSync(SOURCE_LIGHT, 'utf8');
  const light1 = applyMap(lightSource, LIGHT_MAP, 'light');
  const light2 = applyMap(light1.text, BOTH_MAP, 'light-font');
  fs.writeFileSync(OUT_LIGHT, light2.text, 'utf8');
  anyFailed = anyFailed || light1.failed || light2.failed;
  console.log(`  -> ${OUT_LIGHT} (${light1.total + light2.total} total replacements)\n`);

  console.log('Dark theme (lara-dark-green -> sampolio-dark):');
  const darkSource = fs.readFileSync(SOURCE_DARK, 'utf8');
  const dark1 = applyMap(darkSource, DARK_MAP, 'dark');
  const dark2 = applyMap(dark1.text, BOTH_MAP, 'dark-font');
  fs.writeFileSync(OUT_DARK, dark2.text, 'utf8');
  anyFailed = anyFailed || dark1.failed || dark2.failed;
  console.log(`  -> ${OUT_DARK} (${dark1.total + dark2.total} total replacements)\n`);

  if (anyFailed) {
    console.error('copy-themes: one or more expected source tokens had 0 hits — the source theme likely changed. Aborting with non-zero exit.');
    process.exit(1);
  }

  console.log('copy-themes: OK');
}

run();
