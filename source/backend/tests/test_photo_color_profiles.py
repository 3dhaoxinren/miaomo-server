"""Per-photo profile, prepared-variant and renderer integration regressions."""
import copy
import hashlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from PIL import Image

from core import json_renderer, native_dither
from core.cache import ContentCache
from core.image_processing import convert_image_block, normalize_photo_color_profile, quantize_image_for_eink
from core.json_content import _photo_source_and_profile, _select_photo_content, generate_json_mode_content


@pytest.mark.parametrize("value,expected", [("classic", "classic"), ("einkwarm", "einkwarm"),
    (None, "einkwarm"), ("unknown", "einkwarm"), ("CLASSIC", "einkwarm"), ({}, "einkwarm")])
def test_profile_defaults_are_backward_compatible(value, expected):
    assert normalize_photo_color_profile(value) == expected


@pytest.mark.parametrize("profile", ["classic", "einkwarm"])
def test_selected_variant_uses_only_selected_profile_and_never_source_url(profile):
    edit = {"color_profile": profile, "source_url": "/api/uploads/original.png",
            "color_variants": {"classic": "/api/uploads/classic.png", "einkwarm": "/api/uploads/warm.png"}}
    expected = "/api/uploads/classic.png" if profile == "classic" else "/api/uploads/warm.png"
    override = {"photo_edits": [edit]}
    before = copy.deepcopy(override)
    assert _photo_source_and_profile(override, 0, "/api/uploads/current.png") == (expected, profile)
    assert override == before


@pytest.mark.parametrize("variant", [None, "", "  ", 123, "relative.png", "file:///tmp/frame.png", "https:///missing-host", "https://["])
def test_invalid_or_missing_variant_falls_back_to_existing_image_url(variant):
    override = {"photo_edits": [{"color_profile": "classic", "source_url": "/original.png",
                                  "color_variants": {"classic": variant}}]}
    assert _photo_source_and_profile(override, 0, "/current.png") == ("/current.png", "classic")


def test_unknown_profile_and_missing_edit_default_to_warm():
    override = {"photo_edits": [{"color_profile": "future", "color_variants": {"einkwarm": "https://example.test/warm.png"}}]}
    assert _photo_source_and_profile(override, 0, "/current.png") == ("https://example.test/warm.png", "einkwarm")
    assert _photo_source_and_profile(override, 8, "/current.png") == ("/current.png", "einkwarm")
    assert _photo_source_and_profile(override, -1, "/current.png") == ("/current.png", "einkwarm")
    assert _photo_source_and_profile({"photo_edits": [None]}, 0, "/current.png") == ("/current.png", "einkwarm")
    assert _photo_source_and_profile({"photo_edits": {"/current.png": {"color_profile": "classic"}}}, 0, "/current.png") == ("/current.png", "classic")


@pytest.mark.asyncio
async def test_cycle_tracks_original_indices_and_duplicate_urls_without_mutating_config():
    override = {"image_urls": [None, "/same.png", " ", "/same.png", 123, "/third.png"],
                "photo_edits": [{}, {"color_profile": "classic", "color_variants": {"classic": "/first-classic.png"}},
                                {}, {"color_profile": "einkwarm", "color_variants": {"einkwarm": "/second-warm.png"}},
                                {}, {"color_profile": "classic"}]}
    before = copy.deepcopy(override)
    cursor = {"value": 7}  # persisted index beyond current photo count wraps safely
    async def get_index(_mac):
        return cursor["value"]
    async def set_index(_mac, value):
        cursor["value"] = value
    results = []
    with patch("core.config_store.get_photo_frame_index", side_effect=get_index), \
         patch("core.config_store.set_photo_frame_index", side_effect=set_index):
        for _ in range(4):
            content = {}
            await _select_photo_content(content, override, "TEST")
            results.append((content["_photo_index"], content["image_url"], content["photo_color_profile"]))
    assert results == [(3, "/second-warm.png", "einkwarm"), (5, "/third.png", "classic"),
                       (1, "/first-classic.png", "classic"), (3, "/second-warm.png", "einkwarm")]
    assert override == before


@pytest.mark.asyncio
@pytest.mark.parametrize("urls,edits,url,index,profile", [
    (["", None, "/valid.png"], [{}, {}, {"color_profile": "classic"}], "/valid.png", 2, "classic"),
    (["/valid.png"], [], "/valid.png", 0, "einkwarm"),
    ([], [{"color_profile": "classic"}], "/fallback.png", 0, "classic"),
])
async def test_single_preview_uses_matching_edit_without_advancing_cycle(urls, edits, url, index, profile):
    content = {"image_url": "/fallback.png"}
    with patch("core.config_store.get_photo_frame_index", new_callable=AsyncMock) as get_index, \
         patch("core.config_store.set_photo_frame_index", new_callable=AsyncMock) as set_index:
        await _select_photo_content(content, {"image_urls": urls, "photo_edits": edits}, "")
    assert (content["image_url"], content["_photo_index"], content["photo_color_profile"]) == (url, index, profile)
    get_index.assert_not_awaited()
    set_index.assert_not_awaited()


@pytest.mark.asyncio
async def test_static_generator_resolves_variant_before_prefetch():
    mode = {"mode_id": "MY_ADAPTIVE", "content": {"type": "static", "static_data": {}}, "layout": {"body": []}}
    override = {"image_urls": ["/current.png"], "photo_edits": [{"color_profile": "classic", "color_variants": {"classic": "/chosen.png"}}]}
    async def prefetch(content, _mode):
        assert content["image_url"] == "/chosen.png"
        assert content["photo_color_profile"] == "classic"
        return content
    with patch("core.json_content._prefetch_images", side_effect=prefetch):
        content = await generate_json_mode_content(mode, config={"mode_overrides": {"MY_ADAPTIVE": override}})
    assert content["_photo_index"] == 0
    assert mode["content"]["static_data"] == {}


@pytest.mark.parametrize("branch", ["prefetched", "local", "http"])
@pytest.mark.parametrize("profile", ["classic", "einkwarm"])
def test_renderer_propagates_profile_on_every_image_source_branch(branch, profile, tmp_path):
    source = Image.new("RGB", (3, 2), (180, 150, 120))
    buffer = io.BytesIO()
    source.save(buffer, format="PNG")
    local = tmp_path / "input.png"
    local.write_bytes(buffer.getvalue())
    content = {"image_url": "https://example.test/input.png", "photo_color_profile": profile}
    if branch == "prefetched":
        content["_prefetched_image_url"] = buffer.getvalue()
    ctx = SimpleNamespace(content=content, get_field=lambda name: content.get(name), scale=1,
                          screen_w=3, screen_h=2, y=0, colors=4, img=Image.new("RGB", (3, 2)))
    block = {"field": "image_url", "fullscreen": True, "photo_enhance": True,
             "photo_color_profile": "einkwarm", "photo_color_profile_field": "photo_color_profile"}
    response = SimpleNamespace(status_code=200, content=buffer.getvalue())
    client = MagicMock()
    client.__enter__.return_value.get.return_value = response
    with patch.object(json_renderer, "_resolve_local_asset", return_value=local if branch == "local" else None), \
         patch.object(json_renderer, "_is_upload_url", return_value=False), \
         patch.object(json_renderer.httpx, "Client", return_value=client), \
         patch.object(json_renderer, "convert_image_block", return_value=source) as convert:
        json_renderer._render_image(ctx, block)
    assert convert.call_args.kwargs["photo_color_profile"] == profile
    assert convert.call_args.kwargs["photo_enhance"] is True
    convert.call_args.args[0].close()
    assert ctx.y == 2


def test_classic_matches_frozen_pre_warm_preparation_and_atkinson_fixture():
    fixture = Path(__file__).parent / "fixtures" / "classic"
    manifest = json.loads((fixture / "manifest.json").read_text(encoding="utf-8"))
    rgb = (fixture / "photo.rgb").read_bytes()
    expected = (fixture / "photo.idx").read_bytes()
    assert hashlib.sha256(rgb).hexdigest() == manifest["input_sha256"]
    assert hashlib.sha256(expected).hexdigest() == manifest["output_sha256"]
    source = Image.frombytes("RGB", tuple(manifest["size"]), rgb)
    with patch.object(native_dither, "eink_warm", side_effect=AssertionError("classic entered warm math")):
        assert convert_image_block(source, *source.size, 4, photo_enhance=True, photo_color_profile="classic").tobytes() == expected
        assert quantize_image_for_eink(source, colors=4, photo_enhance=True, photo_color_profile="classic").tobytes() == expected


def test_profiles_and_variants_are_isolated_in_existing_preview_cache_identity():
    cache = ContentCache()
    keys = set()
    for profile, url in [("classic", "/a.png"), ("einkwarm", "/a.png"), ("einkwarm", "/b.png")]:
        override = {"photo_edits": [{"color_profile": profile, "color_variants": {profile: url}}]}
        cfg_hash = hashlib.md5(json.dumps(override, sort_keys=True).encode()).hexdigest()[:12]
        keys.add(cache._get_preview_cache_key("MY_ADAPTIVE", 400, 300, mode_override_hash=cfg_hash))
    assert len(keys) == 3
    base = Path(__file__).parents[1] / "core" / "modes" / "builtin"
    for locale in (base, base / "en"):
        mode = json.loads((locale / "my_adaptive.json").read_text(encoding="utf-8"))
        assert mode["cacheable"] is False
        block = next(block for block in mode["layout"]["body"] if block["type"] == "image")
        assert block["photo_color_profile_field"] == "photo_color_profile"
