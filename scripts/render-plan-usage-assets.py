"""Rasterize the deliberately small SVG subset used by plan/usage review exports.

This is a local review/export helper, not a general SVG renderer. Drawing at 2x and reducing to
393x852 preserves thin borders and the production fonts without adding a project dependency.
"""

from __future__ import annotations

from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image, ImageColor, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "docs/design-references/plan-usage-2026-08"
SCALE = 2


def color(value: str | None):
    if not value or value == "none":
        return None
    return ImageColor.getcolor(value, "RGBA")


def number(value: str | None, default: float = 0) -> float:
    return float(value) if value is not None else default


def font_path(family: str, weight: int) -> Path:
    if "Newsreader" in family:
        folder = "newsreader"
        if weight >= 700:
            face = "700Bold/Newsreader_700Bold.ttf"
        elif weight >= 600:
            face = "600SemiBold/Newsreader_600SemiBold.ttf"
        elif weight >= 500:
            face = "500Medium/Newsreader_500Medium.ttf"
        else:
            face = "400Regular/Newsreader_400Regular.ttf"
    else:
        folder = "manrope"
        if weight >= 700:
            face = "700Bold/Manrope_700Bold.ttf"
        elif weight >= 600:
            face = "600SemiBold/Manrope_600SemiBold.ttf"
        elif weight >= 500:
            face = "500Medium/Manrope_500Medium.ttf"
        else:
            face = "400Regular/Manrope_400Regular.ttf"
    return ROOT / "mobile/node_modules/@expo-google-fonts" / folder / face


def line(draw, points, fill, width=2):
    draw.line([(round(x * SCALE), round(y * SCALE)) for x, y in points], fill=fill,
              width=max(1, round(width * SCALE)), joint="curve")


def draw_icon(draw, el):
    kind = el.attrib.get("data-kind")
    x = number(el.attrib.get("data-x"))
    y = number(el.attrib.get("data-y"))
    size = number(el.attrib.get("data-size"), 22)
    stroke = color(el.attrib.get("stroke"))
    k = size / 24
    p = lambda px, py: (x + px * k, y + py * k)
    w = 1.8
    if kind == "back":
        line(draw, [p(15, 18), p(9, 12), p(15, 6)], stroke, w)
    elif kind == "chevron":
        line(draw, [p(9, 18), p(15, 12), p(9, 6)], stroke, w)
    elif kind == "calendar":
        draw.rounded_rectangle([round((x + 4*k)*SCALE), round((y + 5*k)*SCALE),
                                round((x + 20*k)*SCALE), round((y + 21*k)*SCALE)],
                               radius=round(2*k*SCALE), outline=stroke, width=round(w*SCALE))
        line(draw, [p(4, 9), p(20, 9)], stroke, w)
        line(draw, [p(8, 3), p(8, 7)], stroke, w)
        line(draw, [p(16, 3), p(16, 7)], stroke, w)
    elif kind == "clock":
        draw.ellipse([round((x + 3*k)*SCALE), round((y + 3*k)*SCALE),
                      round((x + 21*k)*SCALE), round((y + 21*k)*SCALE)],
                     outline=stroke, width=round(w*SCALE))
        line(draw, [p(12, 7), p(12, 12), p(16, 14)], stroke, w)
    elif kind == "audio":
        draw.arc([round((x + 4*k)*SCALE), round((y + 3*k)*SCALE),
                  round((x + 20*k)*SCALE), round((y + 19*k)*SCALE)], 180, 360,
                 fill=stroke, width=round(w*SCALE))
        line(draw, [p(4, 11), p(4, 20), p(8, 20), p(8, 14), p(4, 14)], stroke, w)
        line(draw, [p(20, 11), p(20, 20), p(16, 20), p(16, 14), p(20, 14)], stroke, w)
    elif kind == "book":
        line(draw, [p(12, 20), p(7, 19), p(4, 21), p(4, 5), p(8, 3), p(12, 4), p(12, 20)], stroke, w)
        line(draw, [p(12, 20), p(17, 19), p(20, 21), p(20, 5), p(16, 3), p(12, 4)], stroke, w)
    elif kind == "spark":
        line(draw, [p(12, 2), p(14, 8), p(20, 10), p(14, 12), p(12, 18), p(10, 12),
                    p(4, 10), p(10, 8), p(12, 2)], stroke, w)
        line(draw, [p(20, 16), p(21, 19), p(18, 20), p(20, 21)], stroke, w)
    elif kind == "settings":
        draw.ellipse([round((x + 8*k)*SCALE), round((y + 8*k)*SCALE),
                      round((x + 16*k)*SCALE), round((y + 16*k)*SCALE)],
                     outline=stroke, width=round(w*SCALE))


def rasterize(svg_path: Path):
    root = ET.parse(svg_path).getroot()
    image = Image.new("RGBA", (393 * SCALE, 852 * SCALE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    for el in root:
        tag = el.tag.rsplit("}", 1)[-1]
        if tag in {"title"}:
            continue
        if tag == "rect":
            x, y = number(el.get("x")), number(el.get("y"))
            w, h = number(el.get("width")), number(el.get("height"))
            r = number(el.get("rx"))
            fill = color(el.get("fill"))
            box = [round(x*SCALE), round(y*SCALE), round((x+w)*SCALE), round((y+h)*SCALE)]
            if fill is not None and fill[3] < 255:
                overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
                overlay_draw = ImageDraw.Draw(overlay)
                overlay_draw.rounded_rectangle(box, radius=round(r*SCALE), fill=fill)
                image = Image.alpha_composite(image, overlay)
                draw = ImageDraw.Draw(image)
                if color(el.get("stroke")):
                    draw.rounded_rectangle(box, radius=round(r*SCALE), outline=color(el.get("stroke")),
                                           width=max(1, round(number(el.get("stroke-width"))*SCALE)))
            else:
                draw.rounded_rectangle(box, radius=round(r*SCALE), fill=fill,
                                       outline=color(el.get("stroke")),
                                       width=max(1, round(number(el.get("stroke-width"))*SCALE)))
        elif tag == "circle":
            cx, cy, r = number(el.get("cx")), number(el.get("cy")), number(el.get("r"))
            draw.ellipse([round((cx-r)*SCALE), round((cy-r)*SCALE), round((cx+r)*SCALE),
                          round((cy+r)*SCALE)], fill=color(el.get("fill")),
                         outline=color(el.get("stroke")),
                         width=max(1, round(number(el.get("stroke-width"))*SCALE)))
        elif tag == "line":
            pts = [(number(el.get("x1")), number(el.get("y1"))),
                   (number(el.get("x2")), number(el.get("y2")))]
            line(draw, pts, color(el.get("stroke")), number(el.get("stroke-width"), 1))
        elif tag == "text":
            size = number(el.get("font-size"), 14)
            weight = int(number(el.get("font-weight"), 400))
            font = ImageFont.truetype(str(font_path(el.get("font-family", "Manrope"), weight)),
                                      round(size*SCALE))
            anchor = {"start": "ls", "middle": "ms", "end": "rs"}.get(el.get("text-anchor"), "ls")
            draw.text((round(number(el.get("x"))*SCALE), round(number(el.get("y"))*SCALE)),
                      el.text or "", font=font, fill=color(el.get("fill")), anchor=anchor)
        elif tag == "path":
            draw_icon(draw, el)
    image = image.resize((393, 852), Image.Resampling.LANCZOS).convert("RGB")
    image.save(svg_path.with_suffix(".png"), quality=95)


for source in sorted(ASSETS.glob("*.svg")):
    rasterize(source)


def contact_sheet(theme: str):
    sources = sorted(ASSETS.glob(f"[0-9][0-9]-*-{theme}.png"))
    gap, label_h, margin = 20, 34, 28
    cols, rows = 4, 2
    cell_w, cell_h = 393, 852 + label_h
    bg = (235, 233, 226) if theme == "light" else (19, 22, 29)
    fg = (28, 33, 41) if theme == "light" else (243, 240, 232)
    sheet = Image.new("RGB", (margin*2 + cols*cell_w + (cols-1)*gap,
                              margin*2 + rows*cell_h + (rows-1)*gap), bg)
    draw = ImageDraw.Draw(sheet)
    label_font = ImageFont.truetype(str(font_path("Manrope", 700)), 16)
    for i, source in enumerate(sources):
        col, row = i % cols, i // cols
        x = margin + col * (cell_w + gap)
        y = margin + row * (cell_h + gap)
        label = source.stem.removesuffix(f"-{theme}").replace('-', ' · ')
        draw.text((x, y + 21), label, font=label_font, fill=fg, anchor="lm")
        frame = Image.open(source).convert("RGB")
        sheet.paste(frame, (x, y + label_h))
    sheet.save(ASSETS / f"contact-sheet-{theme}.png", quality=95)


contact_sheet("light")
contact_sheet("dark")
