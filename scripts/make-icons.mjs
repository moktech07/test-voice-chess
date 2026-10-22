// Generates the PWA icons. Run: node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = resolve(root, 'public/icons');
mkdirSync(iconsDir, { recursive: true });

const BG = '#12100e';
const ACCENT = '#e8b04b';

// Draw with ImageMagick's internal SVG renderer so we have no extra deps.
function svg(size, maskable) {
  const pad = maskable ? size * 0.18 : size * 0.1;
  const s = size;
  const cx = s / 2;
  const cy = s / 2;
  const r = (s - pad * 2) / 2;

  // A knight glyph centred on the tile.
  const fontSize = Math.round(s * (maskable ? 0.34 : 0.44));
  const tile = maskable ? r * 1.62 : r * 1.0;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <rect width="${s}" height="${s}" fill="${BG}"/>
  <rect x="${cx - tile / 2}" y="${cy - tile / 2}" width="${tile}" height="${tile}" rx="${tile * 0.16}" fill="${ACCENT}"/>
  <text x="50%" y="50%" dy="0.35em" text-anchor="middle"
        font-family="DejaVu Sans, Segoe UI Symbol, Noto Sans Symbols 2, serif"
        font-size="${fontSize}" fill="${BG}">&#9822;</text>
</svg>`;
}

const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: false },
];

for (const t of targets) {
  const svgPath = resolve(iconsDir, `.${t.file}.svg`);
  writeFileSync(svgPath, svg(t.size, t.maskable));
  execFileSync('magick', ['-background', 'none', svgPath, resolve(iconsDir, t.file)], {
    stdio: 'inherit',
  });
  console.log('wrote', t.file);
}
