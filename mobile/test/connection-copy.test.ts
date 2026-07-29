// The backend URL used to be a per-session Cloudflare quick-tunnel link, and the UI said so in
// three places. Since Tailscale (dev) and Fly (production) the app SHIPS with a working default
// and almost nobody touches this field — but the copy still told people to paste a
// `*.trycloudflare.com` URL, and it stayed wrong for months because nothing pointed at it.
//
// The guard is on user-visible copy only. `audio/AudioProvider.tsx` legitimately names Cloudflare
// in a comment about the ~100s 524 timeout, which is still exactly true and must not be "fixed".

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

const files = walk(SRC).map((f) => ({ full: f, rel: path.relative(SRC, f) }));

test('the guard actually scans the screens that carry this copy', () => {
  // Without this the two assertions below pass trivially if `walk` ever returns nothing.
  const scanned = files.map((f) => f.rel.split(path.sep).join('/'));
  expect(scanned).toContain('app/settings.tsx');
  expect(scanned.some((r) => r.includes('(tabs)/index.tsx'))).toBe(true);
  expect(files.length).toBeGreaterThan(20);
});

test('no user-facing string tells the reader to paste a trycloudflare URL', () => {
  const offenders = files
    .filter(({ full }) => /trycloudflare/i.test(fs.readFileSync(full, 'utf8')))
    .map(({ rel }) => rel);
  expect(offenders).toEqual([]);
});

test('nothing calls the server URL "the Cloudflare tunnel link"', () => {
  const offenders = files
    .filter(({ full }) => /Cloudflare tunnel link/i.test(fs.readFileSync(full, 'utf8')))
    .map(({ rel }) => rel);
  expect(offenders).toEqual([]);
});
