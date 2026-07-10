"""Generate the Paradigm app icon set: a reference-graph constellation (two mint nodes, one
violet, thin muted edges) on the scholar-dark canvas. Pure numpy + stdlib zlib PNG writer —
no PIL. Analytic anti-aliasing via signed-distance smoothstep."""
import struct
import sys
import zlib

import numpy as np

INK = (0x0B, 0x0D, 0x12)
GLOW = (0x11, 0x14, 0x1C)
MINT = (0x65, 0xD6, 0xB4)
VIOLET = (0x9B, 0x8A, 0xFB)
LINE = (0x99, 0xA3, 0xB7)


def canvas(n):
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    return xx + 0.5, yy + 0.5


def aa(dist):
    """signed distance (px, + outside) -> coverage 0..1 with ~1.2px feather."""
    return np.clip(0.5 - dist / 1.2, 0.0, 1.0)


def circle(xx, yy, cx, cy, r):
    return aa(np.hypot(xx - cx, yy - cy) - r)


def segment(xx, yy, ax, ay, bx, by, w):
    px, py = xx - ax, yy - ay
    dx, dy = bx - ax, by - ay
    t = np.clip((px * dx + py * dy) / (dx * dx + dy * dy), 0.0, 1.0)
    return aa(np.hypot(px - t * dx, py - t * dy) - w / 2)


def over(base_rgb, base_a, rgb, cov, alpha=1.0):
    a = cov * alpha
    out_a = a + base_a * (1 - a)
    safe = np.where(out_a == 0, 1, out_a)
    out_rgb = [
        (rgb[i] * a + base_rgb[i] * base_a * (1 - a)) / safe
        for i in range(3)
    ]
    return out_rgb, out_a


def write_png(path, rgb, a, n):
    img = np.zeros((n, n, 4), dtype=np.uint8)
    for i in range(3):
        img[..., i] = np.clip(rgb[i], 0, 255).astype(np.uint8)
    img[..., 3] = np.clip(a * 255, 0, 255).astype(np.uint8)
    raw = b"".join(b"\x00" + img[row].tobytes() for row in range(n))

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))
    print("wrote", path)


def draw_mark(xx, yy, s, rgb, a, mono=False):
    """The constellation, parameterized by scale s (1.0 = fills a 1024 canvas comfortably)
    around the canvas center. Returns composited (rgb, a)."""
    n = xx.max() + 0.5
    c = n / 2
    # node positions (relative to center, in 1024-scale units)
    A = (c - 215 * s, c - 35 * s)    # anchor node, mint, largest
    B = (c + 140 * s, c - 160 * s)   # violet
    C = (c + 65 * s, c + 200 * s)    # mint
    line_rgb = (255, 255, 255) if mono else LINE
    mint = (255, 255, 255) if mono else MINT
    violet = (255, 255, 255) if mono else VIOLET
    # edges first (under the nodes)
    for (p, q) in ((A, B), (A, C), (B, C)):
        cov = segment(xx, yy, p[0], p[1], q[0], q[1], 13 * s)
        rgb, a = over(rgb, a, line_rgb, cov, 0.55 if not mono else 1.0)
    # nodes: outer ring (ink gap) + fill, so they read on any background
    for (p, r, col) in ((A, 96 * s, mint), (B, 62 * s, violet), (C, 72 * s, mint)):
        rgb, a = over(rgb, a, INK if not mono else (0, 0, 0), circle(xx, yy, p[0], p[1], r + 16 * s), 1.0 if not mono else 0.0)
        rgb, a = over(rgb, a, col, circle(xx, yy, p[0], p[1], r))
    return rgb, a


def solid(n, color, glow=False):
    xx, yy = canvas(n)
    rgb = [np.full((n, n), c, dtype=np.float64) for c in color]
    a = np.ones((n, n))
    if glow:
        # two soft off-center atmosphere discs, like the app background
        for (cx, cy, r) in ((n * 0.75, n * 0.2, n * 0.55), (n * 0.2, n * 0.85, n * 0.45)):
            cov = np.clip(1 - np.hypot(xx - cx, yy - cy) / r, 0, 1) ** 2
            rgb, a = over(rgb, a, GLOW, cov, 0.9)
    return xx, yy, rgb, a


def transparent(n):
    xx, yy = canvas(n)
    return xx, yy, [np.zeros((n, n)) for _ in range(3)], np.zeros((n, n))


out = sys.argv[1] if len(sys.argv) > 1 else "."
N = 1024

# 1) generic icon: dark atmospheric bg + mark
xx, yy, rgb, a = solid(N, INK, glow=True)
rgb, a = draw_mark(xx, yy, 1.0, rgb, a)
write_png(f"{out}/icon.png", rgb, a, N)

# 2) adaptive foreground: mark only, scaled into the ~66% safe zone, transparent bg
xx, yy, rgb, a = transparent(N)
rgb, a = draw_mark(xx, yy, 0.62, rgb, a)
write_png(f"{out}/android-icon-foreground.png", rgb, a, N)

# 3) adaptive background: dark atmosphere
xx, yy, rgb, a = solid(N, INK, glow=True)
write_png(f"{out}/android-icon-background.png", rgb, a, N)

# 4) monochrome (themed icons): white mark on transparent
xx, yy, rgb, a = transparent(N)
rgb, a = draw_mark(xx, yy, 0.62, rgb, a, mono=True)
write_png(f"{out}/android-icon-monochrome.png", rgb, a, N)

# 5) splash icon: mark on transparent (splash bg color comes from app.json)
xx, yy, rgb, a = transparent(512)
xx *= 2; yy *= 2  # keep 1024-scale geometry
rgb, a = draw_mark(xx, yy, 1.0, rgb, a)
write_png(f"{out}/splash-icon.png", rgb, a, 512)
