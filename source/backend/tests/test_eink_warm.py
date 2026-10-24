"""Numerical and transport regressions for four-color photograph rendering."""
from __future__ import annotations

import ctypes
import hashlib
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

from core import native_dither
from core.config import EINK_4COLOR_PALETTE
from core.image_processing import convert_image_block, fit_image_to_box, quantize_image_for_eink
from core.renderer import image_to_png_bytes, image_to_raw_2bpp


FIXTURES = Path(__file__).parent / "fixtures" / "einkwarm"
DEVICE = [(0, 0, 0), (255, 255, 255), (232, 176, 0), (200, 0, 0)]
IDEAL = [(0, 0, 0), (255, 255, 255), (255, 255, 0), (255, 0, 0)]


def _golden_cases():
    manifest = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["schema_version"] == 1
    assert manifest["palette_order"] == ["black", "white", "yellow", "red"]
    assert manifest["profile"] == "einkwarm-natural-std-v1"
    return manifest["cases"]


@pytest.mark.parametrize("case", _golden_cases(), ids=lambda case: case["id"])
def test_independent_golden_rasters(case):
    rgb = (FIXTURES / case["input_rgb"]).read_bytes()
    expected = (FIXTURES / case["expected_idx"]).read_bytes()
    assert hashlib.sha256(rgb).hexdigest() == case["input_sha256"]
    assert hashlib.sha256(expected).hexdigest() == case["output_sha256"]
    size = (case["width"], case["height"])
    assert len(rgb) == size[0] * size[1] * 3
    assert len(expected) == size[0] * size[1]
    source = Image.frombytes("RGB", size, rgb)
    out = convert_image_block(source, *size, 4, photo_enhance=True)
    assert out.mode == "P"
    assert out.getpalette()[:12] == EINK_4COLOR_PALETTE
    assert out.tobytes() == expected
    if not case["passthrough"]:
        assert native_dither.eink_warm(source).tobytes() == expected


@pytest.mark.parametrize("mode", ["RGB", "RGBA", "P"])
@pytest.mark.parametrize("palette", [DEVICE, IDEAL, DEVICE + IDEAL])
@pytest.mark.parametrize("profile", ["classic", "einkwarm"])
def test_encoded_palette_raster_never_reenters_photo_math(mode, palette, profile):
    source = Image.new("RGB", (len(palette), 1))
    source.putdata(palette)
    if mode == "P":
        # Deliberately noncanonical source indices must be decoded by RGB meaning.
        source = source.quantize(colors=len(palette), dither=Image.Dither.NONE)
    else:
        source = source.convert(mode)
    with patch.object(native_dither, "eink_warm", side_effect=AssertionError("double diffusion")), \
         patch.object(native_dither, "atkinson_palette", side_effect=AssertionError("double diffusion")):
        out = convert_image_block(source, len(palette), 1, 4, photo_enhance=True, photo_color_profile=profile)
        direct = quantize_image_for_eink(source, colors=4, photo_enhance=True, photo_color_profile=profile)
    assert out.tobytes() == bytes(range(4)) * (len(palette) // 4)
    assert direct.tobytes() == out.tobytes()


@pytest.mark.parametrize("fit", ["fill", "stretch", "cover", "contain"])
@pytest.mark.parametrize("align_x,align_y", [("left", "top"), ("right", "bottom"), ("center", "center")])
@pytest.mark.parametrize("profile", ["classic", "einkwarm"])
def test_encoded_frame_fitting_keeps_geometry_without_new_palette_colors(fit, align_x, align_y, profile):
    source = Image.new("RGB", (4, 2))
    source.putdata(DEVICE + list(reversed(DEVICE)))
    expected_rgb = fit_image_to_box(source, 7, 9, fit=fit, align_x=align_x, align_y=align_y, resample=Image.Resampling.NEAREST)
    with patch.object(native_dither, "eink_warm", side_effect=AssertionError("double diffusion")), \
         patch.object(native_dither, "atkinson_palette", side_effect=AssertionError("double diffusion")):
        out = convert_image_block(source, 7, 9, 4, fit=fit, align_x=align_x, align_y=align_y, photo_enhance=True, photo_color_profile=profile)
    assert out.convert("RGB").tobytes() == expected_rgb.tobytes()
    assert set(out.tobytes()) <= {0, 1, 2, 3}


def test_photo_does_not_lock_individual_palette_pixels_or_use_old_enhancement():
    source = Image.new("RGB", (4, 1))
    source.putdata([DEVICE[0], DEVICE[1], DEVICE[3], (180, 150, 120)])
    sentinel = Image.new("P", source.size)
    with patch("core.image_processing.enhance_photo_for_eink", side_effect=AssertionError("double enhancement")), \
         patch.object(native_dither, "eink_warm", return_value=sentinel) as warm:
        assert convert_image_block(source, 4, 1, 4, photo_enhance=True) is sentinel
    warm.assert_called_once()
    assert warm.call_args.args[0].tobytes() == source.tobytes()


def test_alpha_composites_on_white_before_photo_math():
    source = Image.new("RGBA", (2, 1))
    source.putdata([(200, 0, 0, 128), (12, 34, 56, 0)])
    sentinel = Image.new("P", source.size)
    with patch.object(native_dither, "eink_warm", return_value=sentinel) as warm:
        convert_image_block(source, 2, 1, 4, photo_enhance=True)
    fitted = warm.call_args.args[0]
    assert fitted.mode == "RGB"
    assert fitted.getpixel((0, 0)) == (227, 127, 127)
    assert fitted.getpixel((1, 0)) == (255, 255, 255)


def test_palette_exif_orientation_is_applied_once():
    source = Image.new("RGB", (2, 1))
    source.putdata([DEVICE[3], DEVICE[2]])
    source.getexif()[274] = 6
    with patch.object(native_dither, "eink_warm", side_effect=AssertionError("double diffusion")):
        out = convert_image_block(source, 1, 2, 4, photo_enhance=True)
    assert out.tobytes() == bytes([3, 2])


def _legacy_atkinson(prepared, colors):
    """Small binary64 oracle for the unchanged legacy native transport."""
    w, h = prepared.size
    if colors == 2:
        data = [[float(value)] for value in ImageOps.autocontrast(prepared.convert("L"), cutoff=1).getdata()]
        palette = [(0,), (255,)]
        allowed = [0, 1]
    else:
        data = [[float(value) for value in pixel] for pixel in prepared.convert("RGB").getdata()]
        palette = DEVICE
        allowed = [0, 1, 3] if colors == 3 else [0, 1, 2, 3]
    out = []
    for y in range(h):
        for x in range(w):
            old = data[y * w + x][:]
            chosen = (1 if old[0] >= 128 else 0) if colors == 2 else min(allowed, key=lambda i: sum((v - p) ** 2 for v, p in zip(old, palette[i])))
            out.append((255 if chosen else 0) if colors == 2 else chosen)
            for dx, dy in [(1, 0), (2, 0), (-1, 1), (0, 1), (1, 1), (0, 2)]:
                if 0 <= x + dx < w and y + dy < h:
                    target = data[(y + dy) * w + x + dx]
                    for channel, value in enumerate(old):
                        target[channel] = max(0.0, min(255.0, target[channel] + (value - palette[chosen][channel]) / 8.0))
    return bytes(out)


@pytest.mark.parametrize("colors", [2, 3])
@pytest.mark.parametrize("enhance", [False, True])
@pytest.mark.parametrize("profile", ["classic", "einkwarm"])
def test_legacy_two_and_three_color_outputs_are_unchanged(colors, enhance, profile):
    source = Image.frombytes("RGB", (9, 7), bytes((i * 37 + i // 11) % 256 for i in range(9 * 7 * 3)))
    prepared = source
    if enhance:
        prepared = ImageOps.autocontrast(source, cutoff=1)
        prepared = ImageEnhance.Contrast(prepared).enhance(1.12)
        prepared = ImageEnhance.Sharpness(prepared).enhance(1.25)
        prepared = prepared.filter(ImageFilter.UnsharpMask(radius=0.8, percent=80, threshold=3))
    expected = _legacy_atkinson(prepared, colors)
    with patch.object(native_dither, "eink_warm", side_effect=AssertionError("legacy branch changed")):
        out = quantize_image_for_eink(source, colors=colors, photo_enhance=enhance, photo_color_profile=profile)
    actual = bytes(out.convert("L").getdata()) if colors == 2 else out.tobytes()
    assert actual == expected


def test_non_photo_four_color_artwork_keeps_atkinson():
    source = Image.new("RGB", (5, 2), (180, 150, 120))
    expected = native_dither.atkinson_palette(source, 4)
    with patch.object(native_dither, "eink_warm", side_effect=AssertionError("artwork branch changed")):
        out = convert_image_block(source, 5, 2, 4, photo_enhance=False)
    assert out.tobytes() == expected.tobytes()


@pytest.mark.parametrize("width,height,rgb_len,out_len,null_input,null_output", [
    (0, 1, 3, 1, False, False), (-1, 1, 3, 1, False, False),
    (1, 1, 2, 1, False, False), (1, 1, 3, 0, False, False),
    (1, 1, 3, 1, True, False), (1, 1, 3, 1, False, True),
    (2**31 - 1, 2**31 - 1, 3, 1, False, False),
])
def test_native_warm_rejects_invalid_buffers_before_access(width, height, rgb_len, out_len, null_input, null_output):
    lib = native_dither._load_lib()
    source = None if null_input else ctypes.create_string_buffer(b"\x80\x80\x80")
    target = None if null_output else ctypes.create_string_buffer(1)
    error = ctypes.create_string_buffer(128)
    status = lib.inksight_eink_warm(source, width, height, rgb_len, target, out_len, error, len(error))
    assert status != 0
    assert error.value


def test_photo_png_and_raw_frame_share_canonical_indices():
    import io
    source = Image.new("RGB", (4, 1))
    source.putdata(IDEAL)
    out = convert_image_block(source, 4, 1, 4, photo_enhance=True)
    reopened = Image.open(io.BytesIO(image_to_png_bytes(out)))
    assert reopened.mode == "P" and reopened.tobytes() == out.tobytes()
    assert image_to_raw_2bpp(reopened) == b"\x1b"
