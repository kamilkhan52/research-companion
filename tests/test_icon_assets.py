import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "mobile" / "assets"
ICON_NAMES = (
    "icon.png",
    "android-icon-foreground.png",
    "android-icon-monochrome.png",
    "splash-icon.png",
    "favicon.png",
)
MINT = (0x65, 0xD6, 0xB4)
VIOLET = (0x9B, 0x8A, 0xFB)


def _rgba_pixels(path):
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
    return [
        tuple(rows[start : start + 4])
        for row in range(height)
        for start in range(row * stride + 1, (row + 1) * stride, 4)
    ]


def test_canonical_icon_is_the_p_alone():
    svg = (ASSETS / "brand" / "paradigm-mark.svg").read_text()
    assert 'fill="#F3F0E8"' in svg
    assert "<circle" not in svg
    assert "stroke=" not in svg
    assert "#65D6B4" not in svg
    assert "#9B8AFB" not in svg


def test_platform_icons_contain_no_secondary_accent_marks():
    for name in ICON_NAMES:
        pixels = _rgba_pixels(ASSETS / "images" / name)
        opaque_colors = {pixel[:3] for pixel in pixels if pixel[3] > 0}
        assert MINT not in opaque_colors
        assert VIOLET not in opaque_colors
