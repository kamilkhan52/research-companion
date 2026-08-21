"""Generate Seminar's Quiet Aperture icon set.

Two warm-paper planes overlap around a true negative-space aperture on a flat
ink canvas. Geometry is shared with ``mobile/assets/brand/seminar-mark.svg``.
Pillow rasterizes the cubic paths at 4x; numpy downsamples coverage; the stdlib
PNG writer keeps every committed platform asset byte-for-byte reproducible.
"""

import re
import struct
import sys
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

INK = (0x0B, 0x0D, 0x12)
PAPER = (0xF3, 0xF0, 0xE8)


def canvas(n):
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    return xx + 0.5, yy + 0.5


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


SUPERSAMPLE = 4
ROOT = Path(__file__).resolve().parents[1]
MARK_SOURCE = ROOT / "mobile" / "assets" / "brand" / "seminar-mark.svg"


def cubic(start, control_1, control_2, end, steps=24):
    """Flatten one SVG cubic segment without duplicating ``start``."""
    p0 = np.asarray(start, dtype=np.float64)
    p1 = np.asarray(control_1, dtype=np.float64)
    p2 = np.asarray(control_2, dtype=np.float64)
    p3 = np.asarray(end, dtype=np.float64)
    points = []
    for t in np.linspace(0.0, 1.0, steps + 1)[1:]:
        u = 1.0 - t
        point = u**3 * p0 + 3 * u**2 * t * p1 + 3 * u * t**2 * p2 + t**3 * p3
        points.append(tuple(point))
    return points


def flatten_path(data):
    """Flatten the small absolute-command subset used by the canonical SVG."""
    tokens = re.findall(r"[A-Za-z]|-?(?:\d+(?:\.\d*)?|\.\d+)", data)
    points = []
    cursor = None
    start = None
    command = None
    index = 0

    def number():
        nonlocal index
        value = float(tokens[index])
        index += 1
        return value

    while index < len(tokens):
        if tokens[index].isalpha():
            command = tokens[index]
            index += 1
        if command == "M":
            cursor = (number(), number())
            start = cursor
            points.append(cursor)
            command = "L"
        elif command == "L":
            cursor = (number(), number())
            points.append(cursor)
        elif command == "H":
            cursor = (number(), cursor[1])
            points.append(cursor)
        elif command == "V":
            cursor = (cursor[0], number())
            points.append(cursor)
        elif command == "C":
            control_1 = (number(), number())
            control_2 = (number(), number())
            end = (number(), number())
            points.extend(cubic(cursor, control_1, control_2, end))
            cursor = end
        elif command == "Z":
            cursor = start
            command = None
        else:
            raise ValueError(f"Unsupported SVG path command: {command}")
    return points


def quiet_aperture_geometry():
    """Read the planes and true aperture from the canonical editable SVG."""
    root = ET.parse(MARK_SOURCE).getroot()
    planes = []
    aperture = None
    for element in root.iter():
        if not element.tag.endswith("path"):
            continue
        data = element.attrib.get("d")
        if not data:
            continue
        if element.attrib.get("fill") == "black":
            aperture = flatten_path(data)
        else:
            planes.append(flatten_path(data))
    if len(planes) != 2 or aperture is None:
        raise ValueError("seminar-mark.svg must contain two planes and one black mask path")
    return planes, aperture


def mark_coverage(n, scale):
    """Rasterize the planes and subtract the aperture as actual transparency."""
    size = n * SUPERSAMPLE
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)

    def transform(points):
        return [
            (
                (n / 2 + (x - 512) * scale) * SUPERSAMPLE,
                (n / 2 + (y - 512) * scale) * SUPERSAMPLE,
            )
            for x, y in points
        ]

    planes, aperture = quiet_aperture_geometry()
    for plane in planes:
        draw.polygon(transform(plane), fill=255)
    draw.polygon(transform(aperture), fill=0)
    pixels = np.asarray(mask, dtype=np.float64) / 255.0
    return pixels.reshape(n, SUPERSAMPLE, n, SUPERSAMPLE).mean(axis=(1, 3))


def draw_mark(xx, yy, scale, rgb, alpha, mono=False):
    """Composite the canonical mark around the current canvas center."""
    n = int(xx.max() + 0.5)
    paper = (255, 255, 255) if mono else PAPER
    return over(rgb, alpha, paper, mark_coverage(n, scale))


def solid(n, color):
    xx, yy = canvas(n)
    rgb = [np.full((n, n), c, dtype=np.float64) for c in color]
    alpha = np.ones((n, n))
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
xx, yy, rgb, alpha = solid(N, INK)
rgb, alpha = draw_mark(xx, yy, 1.0, rgb, alpha)
write_png(f"{out}/icon.png", rgb, alpha, N)

# Android adaptive foreground and themed monochrome stay inside the 66% safe zone.
xx, yy, rgb, alpha = transparent(N)
rgb, alpha = draw_mark(xx, yy, 0.68, rgb, alpha)
write_png(f"{out}/android-icon-foreground.png", rgb, alpha, N)

xx, yy, rgb, alpha = solid(N, INK)
write_png(f"{out}/android-icon-background.png", rgb, alpha, N)

xx, yy, rgb, alpha = transparent(N)
rgb, alpha = draw_mark(xx, yy, 0.68, rgb, alpha, mono=True)
write_png(f"{out}/android-icon-monochrome.png", rgb, alpha, N)

# Splash mark uses transparent pixels; the configured splash supplies the canvas.
xx, yy, rgb, alpha = transparent(512)
rgb, alpha = draw_mark(xx, yy, 0.50, rgb, alpha)
write_png(f"{out}/splash-icon.png", rgb, alpha, 512)

# Supersampled favicon so the same silhouette stays clean at browser-tab size.
xx, yy, rgb, alpha = solid(192, INK)
rgb, alpha = draw_mark(xx, yy, 0.18, rgb, alpha)
rgb, alpha = downsample_rgba(rgb, alpha, 4)
write_png(f"{out}/favicon.png", rgb, alpha, 48)
