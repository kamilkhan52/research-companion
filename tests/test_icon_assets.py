import json
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "mobile" / "assets"
ICON_NAMES = (
    "icon.png",
    "android-icon-background.png",
    "android-icon-foreground.png",
    "android-icon-monochrome.png",
    "splash-icon.png",
    "favicon.png",
)
MINT = (0x65, 0xD6, 0xB4)
VIOLET = (0x9B, 0x8A, 0xFB)
INK = (0x0B, 0x0D, 0x12)
PAPER = (0xF3, 0xF0, 0xE8)


def _rgba_image(path):
    payload = path.read_bytes()
    assert payload.startswith(b"\x89PNG\r\n\x1a\n")
    offset = 8
    width = height = None
    compressed = bytearray()
    while offset < len(payload):
        size = struct.unpack(">I", payload[offset : offset + 4])[0]
        tag = payload[offset + 4 : offset + 8]
        chunk = payload[offset + 8 : offset + 8 + size]
        offset += 12 + size
        if tag == b"IHDR":
            width, height, bit_depth, color_type = struct.unpack(">IIBB", chunk[:10])
            assert (bit_depth, color_type) == (8, 6)
        elif tag == b"IDAT":
            compressed.extend(chunk)
        elif tag == b"IEND":
            break
    assert width is not None and height is not None
    rows = zlib.decompress(compressed)
    stride = width * 4 + 1
    assert len(rows) == stride * height
    assert all(rows[row * stride] == 0 for row in range(height))
    pixels = [
        tuple(rows[start : start + 4])
        for row in range(height)
        for start in range(row * stride + 1, (row + 1) * stride, 4)
    ]
    return width, height, pixels


def test_canonical_icon_is_the_name_independent_quiet_aperture():
    svg = (ASSETS / "brand" / "seminar-mark.svg").read_text()
    assert "Seminar Quiet Aperture mark" in svg
    assert 'fill="#F3F0E8"' in svg
    assert '<mask id="aperture"' in svg
    assert "M512 452L572 512L512 572L452 512Z" in svg
    assert "<circle" not in svg
    assert "stroke=" not in svg
    assert "<text" not in svg
    assert "#65D6B4" not in svg
    assert "#9B8AFB" not in svg
    assert not (ASSETS / "brand" / "paradigm-mark.svg").exists()

    generator = (ROOT / "scripts" / "gen_app_icons.py").read_text()
    assert '"seminar-mark.svg"' in generator
    assert "quiet_aperture_paths" not in generator


def test_platform_icons_contain_no_secondary_accent_marks():
    for name in ICON_NAMES:
        _, _, pixels = _rgba_image(ASSETS / "images" / name)
        opaque_colors = {pixel[:3] for pixel in pixels if pixel[3] > 0}
        assert MINT not in opaque_colors
        assert VIOLET not in opaque_colors


def test_platform_icon_dimensions_and_layer_contracts():
    images = {
        name: _rgba_image(ASSETS / "images" / name)
        for name in ICON_NAMES
    }
    assert {name: value[:2] for name, value in images.items()} == {
        "icon.png": (1024, 1024),
        "android-icon-background.png": (1024, 1024),
        "android-icon-foreground.png": (1024, 1024),
        "android-icon-monochrome.png": (1024, 1024),
        "splash-icon.png": (512, 512),
        "favicon.png": (48, 48),
    }

    _, _, background = images["android-icon-background.png"]
    assert set(background) == {(*INK, 255)}

    for name in ("android-icon-foreground.png", "android-icon-monochrome.png", "splash-icon.png"):
        width, _, pixels = images[name]
        center = pixels[(width // 2) * width + width // 2]
        assert center[3] == 0, f"{name} must keep the aperture transparent"
        assert any(pixel[3] == 0 for pixel in pixels)
        assert any(pixel[3] == 255 for pixel in pixels)

    _, _, foreground = images["android-icon-foreground.png"]
    assert all(pixel[3] == 0 or pixel[:3] == PAPER for pixel in foreground)
    foreground_alpha = [
        (index % 1024, index // 1024)
        for index, pixel in enumerate(foreground)
        if pixel[3] > 0
    ]
    xs, ys = zip(*foreground_alpha, strict=True)
    safe_margin = 1024 * (21 / 108)
    assert min(xs) >= safe_margin
    assert min(ys) >= safe_margin
    assert max(xs) <= 1024 - safe_margin
    assert max(ys) <= 1024 - safe_margin

    _, _, monochrome = images["android-icon-monochrome.png"]
    assert all(pixel[3] == 0 or pixel[:3] == (255, 255, 255) for pixel in monochrome)


def test_expo_config_uses_the_generated_icon_set():
    config = json.loads((ROOT / "mobile" / "app.json").read_text())["expo"]
    assert config["icon"] == "./assets/images/icon.png"
    assert config["ios"]["icon"] == "./assets/images/icon.png"
    assert config["web"]["favicon"] == "./assets/images/favicon.png"
    assert config["android"]["adaptiveIcon"] == {
        "backgroundColor": "#0B0D12",
        "foregroundImage": "./assets/images/android-icon-foreground.png",
        "backgroundImage": "./assets/images/android-icon-background.png",
        "monochromeImage": "./assets/images/android-icon-monochrome.png",
    }
