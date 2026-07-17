// R.2 migration guards (docs/theming-design.md): with the migration complete, nothing under
// src/ outside theme/ may (A) read a flat palette export from tokens, or (B) inline an
// rgba()/hex color literal — either would silently re-introduce a dark-baked surface that
// only shows up when a user switches to Black/Light. Fix a violation by reading useTheme()/
// useThemedStyles(), or by promoting a genuinely new color to a token in ALL THREE palettes.

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');

/** Files whose colors are content, not chrome (rendered artwork), or platform-structural. */
const LITERAL_ALLOWLIST = new Set([
  'components/PaperCover.tsx', // generated cover art: gradients/sheen are the artwork itself
]);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

const files = walk(SRC)
  .map((f) => ({ full: f, rel: path.relative(SRC, f) }))
  .filter(({ rel }) => !rel.startsWith('theme' + path.sep));

test('no file outside theme/ imports a flat palette from tokens', () => {
  const offenders: string[] = [];
  for (const { full, rel } of files) {
    const src = fs.readFileSync(full, 'utf8');
    const importMatch = src.match(/import[^;]*from '@\/theme\/tokens'/g) ?? [];
    for (const imp of importMatch) {
      if (/\bcolors\b/.test(imp) || /\bstateMeta\b(?!For)/.test(imp)) {
        offenders.push(`${rel}: ${imp.replace(/\s+/g, ' ')}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test('no inline rgba()/hex color literals outside theme/ (use tokens)', () => {
  const offenders: string[] = [];
  for (const { full, rel } of files) {
    if (LITERAL_ALLOWLIST.has(rel.split(path.sep).join('/'))) continue;
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.split('//')[0]; // ignore comments
      if (/shadowColor/.test(code)) return; // structural shadows are always-black
      if (/rgba?\(/.test(code) || /['"]#[0-9a-fA-F]{3,8}['"]/.test(code)) {
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  expect(offenders).toEqual([]);
});
