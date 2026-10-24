# Native e-ink dithering

This directory contains the required C++ image quantizers: legacy Atkinson for
black/white, three-color and artwork, and natural/std warm processing for
four-color photographs. Warm processing uses luma auto-levels, channel unsharp
at 0.30, natural HSL mapping, calibrated power decode (1.75), and serpentine
Floyd–Steinberg diffusion at 0.85. Its index output is K/W/Y/R; the existing
device display RGB palette is unchanged.

Build from the repository root:

```bash
python3 backend/scripts/build_native_dither.py
```

The generated `libeink_dither.so` is ignored by git. Runtime requires a matching
library, including the `inksight_eink_warm` export. Missing or outdated native
libraries fail explicitly; there is no Python fallback. The backend Dockerfile
builds the library and checks all native transports before producing its image.

The length-checked warm ABI accepts opaque RGB bytes and emits one index per
pixel, top-left row-major. It rejects invalid dimensions, mismatched buffer
lengths and rasters over 16 million pixels. The Python image-block boundary
preserves entire already encoded palette-only frames before photo preparation
and uses nearest-neighbor fitting for those frames. It does not lock individual
palette-colored pixels inside ordinary photographs. Original uploads are kept.
