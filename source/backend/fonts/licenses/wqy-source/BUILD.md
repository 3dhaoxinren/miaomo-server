# WenQuanYi Bitmap Song corresponding source

Only the three BDF source fonts corresponding to the bundled PCFs are included.
Source release: WenQuanYi Bitmap Song 0.9.9.8 (1.0 Hero RC1), release 8.
Distribution mirror: https://github.com/deepin-community/xfonts-wqy/tree/9c5ad0a1230d97a255560456efca82ea1a5a0b82
All fetched bytes were verified against Git blob identifiers independently returned by GitHub. See SOURCES.json for SHA-256 and original URLs.

Files are under GPL version 2 with the font embedding exception stated in their source comments and the adjacent WenQuanYi-README.txt / WenQuanYi-debian-copyright.txt. Preserve the unmodified source comments and those notices. The complete GPL2 text is adjacent in WenQuanYi-COPYING-GPL-2.0.txt. WenQuanYi-README.txt is the upstream release documentation in its original Latin-1 encoding; its separate GFDL1.2-or-later terms and the full GFDL text are also adjacent.

## Build the PCFs

Install X.Org bdftopcf (Debian/Ubuntu package xfonts-utils). Published layout: this directory is `source/backend/fonts/licenses/wqy-source`; the existing PCFs are in `../../bitmap`. From this directory:

```sh
python prepare_subset.py ../../bitmap
mkdir -p rebuilt
bdftopcf -o rebuilt/wqy-song-10.pcf subsets/wenquanyi_10pt.bdf
bdftopcf -o rebuilt/wqy-song-12.pcf subsets/wenquanyi_12pt.bdf
bdftopcf -o rebuilt/wqy-zenhei-13.pcf subsets/wenquanyi_13px.bdf
```

The third product filename is a historical alias: its embedded FONT_NAME and FAMILY_NAME are WenQuanYi Bitmap Song; it is not the separate Zen Hei TrueType font. No source patch or font-generation dependency beyond the X.Org converter is required. Converter version/default padding can change binary PCF bytes; compare glyphs/metrics when binary-layout differences occur.

## Independent equivalence check

With Python and Pillow installed:

```sh
python verify_glyphs.py ../../bitmap
```

The helper compares all encoded Unicode codepoints, horizontal advances, glyph bounding boxes and each raster bit against the supplied BDF. It uses Pillow to decode the PCF and an independently authored BDF parser. This verifies rendering identity, not converter byte layout or unexamined PCF metadata. `glyph-verification.json` records the run against the release's original bundled fonts. No product runtime source is changed by this helper.

## Source-match result and subset preparation

Every bundled PCF glyph matches the original BDF raster/advance/bounding box exactly. PCF encoded glyph counts are 30,142 / 30,083 / 22,823 respectively. The original BDFs are supersets with 78 / 11,212 / 29 additional encoded characters. No bundled character is absent from source. `prepare_subset.py` preserves every retained original glyph block and source notice, adjusting only CHARS and the glyph selection to the published PCF encoding tables. Generated files under subsets/ are derived subsets prepared for this release on 2026-10-24; original BDF files above are unmodified. This preparation is necessary to reproduce the shipped character coverage. No claim is made about identical PCF table ordering or byte padding.
