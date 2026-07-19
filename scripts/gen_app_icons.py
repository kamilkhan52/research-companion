"""Generate the Paradigm “P” icon set.

The mark combines an editorial slab-serif P, a mint research path, and a violet
evidence node on the Scholar Dark canvas. Pure numpy + stdlib zlib PNG writer:
no font rasterizer or image library, so every platform asset is reproducible.
"""

import struct
import sys
import zlib

import numpy as np

INK = (0x0B, 0x0D, 0x12)
GLOW = (0x11, 0x14, 0x1C)
PAPER = (0xF3, 0xF0, 0xE8)
MINT = (0x65, 0xD6, 0xB4)
VIOLET = (0x9B, 0x8A, 0xFB)


def canvas(n):
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    return xx + 0.5, yy + 0.5


def aa(dist):
    """Signed distance (px, + outside) → coverage with a ~1.2 px feather."""
    return np.clip(0.5 - dist / 1.2, 0.0, 1.0)


def circle(xx, yy, cx, cy, r):
    return aa(np.hypot(xx - cx, yy - cy) - r)


def ellipse(xx, yy, cx, cy, rx, ry):
    # Accurate enough at the edge for analytic AA while remaining dependency-free.
    normalized = np.hypot((xx - cx) / rx, (yy - cy) / ry)
    return aa((normalized - 1) * min(rx, ry))


def round_rect(xx, yy, cx, cy, hx, hy, r):
    qx = np.abs(xx - cx) - (hx - r)
    qy = np.abs(yy - cy) - (hy - r)
    outside = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0))
    inside = np.minimum(np.maximum(qx, qy), 0)
    return aa(outside + inside - r)


def segment(xx, yy, ax, ay, bx, by, width):
    px, py = xx - ax, yy - ay
    dx, dy = bx - ax, by - ay
    t = np.clip((px * dx + py * dy) / (dx * dx + dy * dy), 0.0, 1.0)
    return aa(np.hypot(px - t * dx, py - t * dy) - width / 2)


def cubic_path(xx, yy, p0, p1, p2, p3, width, steps=28):
    ts = np.linspace(0, 1, steps + 1)
    points = []
    for t in ts:
        u = 1 - t
        points.append(
            (
                u**3 * p0[0] + 3 * u**2 * t * p1[0] + 3 * u * t**2 * p2[0] + t**3 * p3[0],
                u**3 * p0[1] + 3 * u**2 * t * p1[1] + 3 * u * t**2 * p2[1] + t**3 * p3[1],
            )
        )
    coverage = np.zeros_like(xx)
    for index in range(len(points) - 1):
        a, b = points[index], points[index + 1]
        coverage = np.maximum(coverage, segment(xx, yy, a[0], a[1], b[0], b[1], width))
    return coverage


def over(base_rgb, base_a, rgb, coverage, alpha=1.0):
    a = coverage * alpha
    out_a = a + base_a * (1 - a)
    safe = np.where(out_a == 0, 1, out_a)
    out_rgb = [
        (rgb[i] * a + base_rgb[i] * base_a * (1 - a)) / safe
        for i in range(3)
    ]
    return out_rgb, out_a


def write_png(path, rgb, alpha, n):
    img = np.zeros((n, n, 4), dtype=np.uint8)
    for i in range(3):
        img[..., i] = np.clip(rgb[i], 0, 255).astype(np.uint8)
    img[..., 3] = np.clip(alpha * 255, 0, 255).astype(np.uint8)
    raw = b"".join(b"\x00" + img[row].tobytes() for row in range(n))

    def chunk(tag, data):
        content = tag + data
        return (
            struct.pack(">I", len(data))
            + content
            + struct.pack(">I", zlib.crc32(content))
        )

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))
    print("wrote", path)


def draw_mark(xx, yy, scale, rgb, alpha, mono=False):
    """Composite the mark around the current canvas center.

    ``scale=1`` uses the canonical 1024-unit geometry. Smaller values keep the
    same optical proportions for adaptive and compact assets.
    """
    n = xx.max() + 0.5
    cx, cy = n / 2, n / 2

    def pt(x, y):
        return cx + (x - 512) * scale, cy + (y - 512) * scale

    paper = (255, 255, 255) if mono else PAPER
    mint = (255, 255, 255) if mono else MINT
    violet = (255, 255, 255) if mono else VIOLET

    # P silhouette: quiet slab serifs plus an ample counter that remains open at 24 px.
    stem = round_rect(xx, yy, *pt(390, 512), 62 * scale, 300 * scale, 10 * scale)
    top_serif = round_rect(xx, yy, *pt(435, 220), 135 * scale, 20 * scale, 8 * scale)
    bottom_serif = round_rect(xx, yy, *pt(410, 792), 110 * scale, 20 * scale, 8 * scale)
    outer = ellipse(xx, yy, *pt(490, 392), 220 * scale, 190 * scale)
    inner = ellipse(xx, yy, *pt(500, 395), 112 * scale, 90 * scale)
    bowl = np.clip(outer - inner, 0, 1)
    p_coverage = np.maximum.reduce((stem, top_serif, bottom_serif, bowl))
    rgb, alpha = over(rgb, alpha, paper, p_coverage)

    # One continuous research path rises through the counter to a grounded evidence node.
    path = cubic_path(
        xx,
        yy,
        pt(405, 690),
        pt(405, 560),
        pt(600, 560),
        pt(555, 405),
        28 * scale,
    )
    rgb, alpha = over(rgb, alpha, mint, path)
    rgb, alpha = over(rgb, alpha, violet, circle(xx, yy, *pt(555, 405), 38 * scale))
    return rgb, alpha


def solid(n, color, glow=False):
    xx, yy = canvas(n)
    rgb = [np.full((n, n), c, dtype=np.float64) for c in color]
    alpha = np.ones((n, n))
    if glow:
        for cx, cy, radius in (
            (n * 0.75, n * 0.20, n * 0.55),
            (n * 0.20, n * 0.85, n * 0.45),
        ):
            coverage = np.clip(1 - np.hypot(xx - cx, yy - cy) / radius, 0, 1) ** 2
            rgb, alpha = over(rgb, alpha, GLOW, coverage, 0.9)
    return xx, yy, rgb, alpha


def transparent(n):
    xx, yy = canvas(n)
    return xx, yy, [np.zeros((n, n)) for _ in range(3)], np.zeros((n, n))


def downsample_rgba(rgb, alpha, factor):
    def shrink(channel):
        h, w = channel.shape
        return channel.reshape(h // factor, factor, w // factor, factor).mean(axis=(1, 3))

    return [shrink(channel) for channel in rgb], shrink(alpha)


out = sys.argv[1] if len(sys.argv) > 1 else "."
N = 1024

# Generic + iOS icon.
xx, yy, rgb, alpha = solid(N, INK, glow=True)
rgb, alpha = draw_mark(xx, yy, 1.0, rgb, alpha)
write_png(f"{out}/icon.png", rgb, alpha, N)

# Android adaptive foreground and themed monochrome stay inside the 66% safe zone.
xx, yy, rgb, alpha = transparent(N)
rgb, alpha = draw_mark(xx, yy, 0.68, rgb, alpha)
write_png(f"{out}/android-icon-foreground.png", rgb, alpha, N)

xx, yy, rgb, alpha = solid(N, INK, glow=True)
write_png(f"{out}/android-icon-background.png", rgb, alpha, N)

xx, yy, rgb, alpha = transparent(N)
rgb, alpha = draw_mark(xx, yy, 0.68, rgb, alpha, mono=True)
write_png(f"{out}/android-icon-monochrome.png", rgb, alpha, N)

# Splash mark uses transparent pixels; the configured splash supplies the canvas.
xx, yy, rgb, alpha = transparent(512)
rgb, alpha = draw_mark(xx, yy, 0.50, rgb, alpha)
write_png(f"{out}/splash-icon.png", rgb, alpha, 512)

# Supersampled favicon so the same silhouette stays clean at browser-tab size.
xx, yy, rgb, alpha = solid(192, INK, glow=True)
rgb, alpha = draw_mark(xx, yy, 0.18, rgb, alpha)
rgb, alpha = downsample_rgba(rgb, alpha, 4)
write_png(f"{out}/favicon.png", rgb, alpha, 48)
