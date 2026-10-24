"""Reusable image fitting and e-ink quantization helpers."""
from __future__ import annotations

from PIL import Image, ImageEnhance, ImageFilter, ImageOps

from . import native_dither
from .config import EINK_4COLOR_PALETTE


_ENCODED_EINK_COLORS = {
    (0, 0, 0): 0,
    (255, 255, 255): 1,
    (232, 176, 0): 2,
    (200, 0, 0): 3,
    (255, 255, 0): 2,
    (255, 0, 0): 3,
}


def normalize_photo_color_profile(value: object) -> str:
    return "classic" if value == "classic" else "einkwarm"


def _palette_only_image(src: Image.Image) -> Image.Image | None:
    """Recognize complete encoded frames; never pin individual pixels in a photo."""
    rgba = src.convert("RGBA")
    if rgba.getextrema()[3] != (255, 255):
        return None
    rgb = rgba.convert("RGB")
    colors = rgb.getcolors(maxcolors=len(_ENCODED_EINK_COLORS))
    if colors is None or any(color not in _ENCODED_EINK_COLORS for _, color in colors):
        return None
    indices = bytes(_ENCODED_EINK_COLORS[color] for color in rgb.getdata())
    out = Image.frombytes("P", rgb.size, indices)
    out.putpalette(EINK_4COLOR_PALETTE + [0] * (768 - len(EINK_4COLOR_PALETTE)))
    return out


def _aligned_offset(container: int, content: int, align: str) -> int:
    if align in ("left", "top", "start"):
        return 0
    if align in ("right", "bottom", "end"):
        return container - content
    return (container - content) // 2


def fit_image_to_box(
    src: Image.Image,
    width: int,
    height: int,
    *,
    fit: str = "fill",
    align_x: str = "center",
    align_y: str = "center",
    resample: Image.Resampling = Image.Resampling.LANCZOS,
) -> Image.Image:
    """Fit an image into an RGB box using JSON image-block semantics."""
    src_rgba = ImageOps.exif_transpose(src).convert("RGBA")
    fit_mode = str(fit or "fill").lower()
    if fit_mode in ("fill", "stretch"):
        base = Image.new("RGBA", (width, height), (255, 255, 255, 255))
        base.alpha_composite(src_rgba.resize((width, height), resample))
        return base.convert("RGB")

    src_w = max(1, src_rgba.size[0])
    src_h = max(1, src_rgba.size[1])
    scale_x = width / src_w
    scale_y = height / src_h
    scale = min(scale_x, scale_y) if fit_mode == "contain" else max(scale_x, scale_y)
    resized_w = max(1, int(round(src_w * scale)))
    resized_h = max(1, int(round(src_h * scale)))
    resized = src_rgba.resize((resized_w, resized_h), resample)
    base = Image.new("RGBA", (width, height), (255, 255, 255, 255))
    paste_x = _aligned_offset(width, resized_w, align_x)
    paste_y = _aligned_offset(height, resized_h, align_y)
    base.alpha_composite(resized, (paste_x, paste_y))
    return base.convert("RGB")


def enhance_photo_for_eink(rgb: Image.Image) -> Image.Image:
    """Conservative photo preparation before e-ink quantization."""
    img = ImageOps.autocontrast(rgb.convert("RGB"), cutoff=1)
    img = ImageEnhance.Contrast(img).enhance(1.12)
    img = ImageEnhance.Sharpness(img).enhance(1.25)
    return img.filter(ImageFilter.UnsharpMask(radius=0.8, percent=80, threshold=3))


def quantize_image_for_eink(
    rgb: Image.Image,
    *,
    colors: int,
    photo_enhance: bool = False,
    photo_color_profile: str = "einkwarm",
) -> Image.Image:
    """Apply the selected photo profile while retaining legacy artwork/BW paths."""
    if colors >= 4 and photo_enhance:
        encoded = _palette_only_image(rgb)
        if encoded is not None:
            return encoded
        if normalize_photo_color_profile(photo_color_profile) == "einkwarm":
            return native_dither.eink_warm(rgb)
    prepared = enhance_photo_for_eink(rgb) if photo_enhance else rgb.convert("RGB")

    if colors < 3:
        gray = ImageOps.autocontrast(prepared.convert("L"), cutoff=1)
        return native_dither.atkinson_bw(gray)

    return native_dither.atkinson_palette(prepared, 3 if colors == 3 else 4)


def convert_image_block(
    src: Image.Image,
    width: int,
    height: int,
    colors: int,
    *,
    fit: str = "fill",
    align_x: str = "center",
    align_y: str = "center",
    photo_enhance: bool = False,
    photo_color_profile: str = "einkwarm",
) -> Image.Image:
    """Fit and quantize an image for a JSON image block."""
    if colors >= 4 and photo_enhance:
        encoded = _palette_only_image(ImageOps.exif_transpose(src))
        if encoded is not None:
            fitted = fit_image_to_box(
                encoded, width, height, fit=fit, align_x=align_x, align_y=align_y,
                resample=Image.Resampling.NEAREST,
            )
            preserved = _palette_only_image(fitted)
            if preserved is None:
                raise RuntimeError("encoded frame fitting introduced unsupported colors")
            return preserved
        fitted = fit_image_to_box(src, width, height, fit=fit, align_x=align_x, align_y=align_y)
        if normalize_photo_color_profile(photo_color_profile) == "einkwarm":
            return native_dither.eink_warm(fitted)
        return native_dither.atkinson_palette(enhance_photo_for_eink(fitted), 4)
    fitted = fit_image_to_box(src, width, height, fit=fit, align_x=align_x, align_y=align_y)
    return quantize_image_for_eink(
        fitted,
        colors=colors,
        photo_enhance=photo_enhance,
        photo_color_profile=photo_color_profile,
    )
