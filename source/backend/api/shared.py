from __future__ import annotations

import asyncio
import copy
import hashlib
import io
import json
import logging
import os
import random
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx
from dotenv import load_dotenv
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from PIL import Image, ImageDraw, ImageFont
from core.patterns.utils import load_font

try:  # pragma: no cover - exercised implicitly at import time
    from slowapi import Limiter, _rate_limit_exceeded_handler
    from slowapi.errors import RateLimitExceeded
    from slowapi.util import get_remote_address
except ImportError:  # pragma: no cover
    class _DummyLimiter:
        def __init__(self, *args, **kwargs):
            pass

        def limit(self, *args, **kwargs):
            def decorator(func):
                return func

            return decorator

    def get_remote_address(request: Request) -> str:
        client = getattr(request, "client", None)
        return getattr(client, "host", "unknown") if client else "unknown"

    class RateLimitExceeded(Exception):
        """Fallback rate limit exception (never actually raised without slowapi)."""

    async def _rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded):
        return JSONResponse(
            status_code=429,
            content={
                "error": "rate_limit_unavailable",
                "message": "Rate limiting is not enabled on this server.",
            },
        )

    Limiter = _DummyLimiter  # type: ignore

from core.auth import (
    optional_user,
    require_device_token,
    validate_mac_param,
)
from core.cache import content_cache
from core.config import (
    DEFAULT_CITY,
    DEFAULT_MODES,
    DEFAULT_REFRESH_INTERVAL,
    get_default_llm_model_for_provider,
)
from core.config_store import (
    get_active_config,
    get_cycle_index,
    get_device_membership,
    get_device_state,
    init_db,
    set_cycle_index,
    update_device_state,
)
from core.context import calc_battery_pct, extract_location_settings, get_date_context, get_weather
from core.pipeline import generate_and_render, get_effective_mode_config
from core.renderer import image_to_bmp_bytes
from core.stats_store import (
    get_latest_battery_voltage,
    init_stats_db,
    log_heartbeat,
    log_render,
    save_render_content,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

DISCOVERY_WINDOW_MINUTES = 15
ONLINE_WINDOW_MINUTES = 15

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


@asynccontextmanager
async def lifespan(app):
    await init_db()
    await init_stats_db()
    from core.cache import init_cache_db
    from core.db import close_all
    from core.static_store import init_static_tables, migrate_device_state_columns

    await init_cache_db()
    await init_static_tables()
    await migrate_device_state_columns()
    from core.local_store import load_global_custom_modes
    await load_global_custom_modes()

    yield

    await close_all()


def _rate_limit_key(request: Request) -> str:
    mac = request.query_params.get("mac")
    if mac:
        return f"mac:{mac}"
    return get_remote_address(request)


class _NoopLimiter:
    def __init__(self, *args, **kwargs):
        pass

    def limit(self, *args, **kwargs):
        def decorator(func):
            return func

        return decorator


try:
    limiter = Limiter(key_func=_rate_limit_key, storage_uri="memory://")
except Exception as exc:  # pragma: no cover - depends on optional runtime dependency
    logger.warning("Rate limiter disabled due to init error: %s", exc)
    limiter = _NoopLimiter()


async def inksight_error_handler(request: Request, exc):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": type(exc).__name__, "message": exc.message},
    )




async def resolve_user_id(request: Request, ink_session: Optional[str]) -> Optional[int]:
    return await optional_user(request, ink_session)


async def require_membership_access(
    request: Request,
    mac: str,
    ink_session: Optional[str],
    *,
    owner_only: bool = False,
) -> dict:
    mac = validate_mac_param(mac)
    device = await get_device_membership(mac, 1)
    if not device:
        raise HTTPException(status_code=403, detail="请先在本地设备列表中添加此设备")
    return device



async def ensure_web_or_device_access(
    request: Request,
    mac: str,
    x_device_token: Optional[str],
    ink_session: Optional[str],
    *,
    owner_only: bool = False,
    allow_device_token: bool = True,
) -> dict:
    mac = validate_mac_param(mac)
    logger.info("[AUTH] ensure_web_or_device_access: mac=%s, has_device_token=%s, has_ink_session=%s",
                mac, bool(x_device_token), bool(ink_session))
    if allow_device_token and x_device_token:
        await require_device_token(mac, x_device_token)
        return {"mode": "device", "role": "device"}
    membership = await require_membership_access(request, mac, ink_session, owner_only=owner_only)
    return {"mode": "local", **membership}


FIRMWARE_CHIP_FAMILY = "ESP32-C3"
FIRMWARE_RELEASE_CACHE_TTL = int(os.getenv("FIRMWARE_RELEASE_CACHE_TTL", "120"))
GITHUB_OWNER = os.getenv("GITHUB_OWNER", "datascale-ai")
GITHUB_REPO = os.getenv("GITHUB_REPO", "inksight")
GITHUB_RELEASES_API = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases"
_firmware_release_cache = {
    "expires_at": 0.0,
    "payload": None,
}
_firmware_release_cache_lock = asyncio.Lock()
_preview_push_queue: dict[str, dict] = {}
_preview_push_queue_lock = asyncio.Lock()

_SMART_TIME_SLOTS = [
    (6, 9, ["RECIPE", "DAILY"]),
    (9, 12, ["BRIEFING", "STOIC"]),
    (12, 14, ["ZEN", "POETRY"]),
    (14, 18, ["STOIC", "ROAST"]),
    (18, 21, ["FITNESS", "RECIPE"]),
    (21, 24, ["ZEN", "POETRY"]),
    (0, 6, ["ZEN", "POETRY"]),
]


async def choose_persona_from_config(config: dict, peek_next: bool = False) -> str:
    modes = config.get("modes", DEFAULT_MODES) or DEFAULT_MODES
    strategy = config.get("refresh_strategy", "random")

    if strategy == "cycle":
        mac = config.get("mac", "default")
        idx = await get_cycle_index(mac)
        persona = modes[idx % len(modes)]
        if not peek_next:
            await set_cycle_index(mac, idx + 1)
        return persona

    if strategy == "time_slot":
        hour = datetime.now().hour
        rules = config.get("time_slot_rules", [])
        for rule in rules:
            start_h = rule.get("startHour", 0)
            end_h = rule.get("endHour", 24)
            rule_modes = rule.get("modes", [])
            if start_h <= hour < end_h and rule_modes:
                available = [mode for mode in rule_modes if mode in modes]
                if available:
                    return random.choice(available)
        return random.choice(modes)

    if strategy == "smart":
        hour = datetime.now().hour
        for start_h, end_h, candidates in _SMART_TIME_SLOTS:
            if start_h <= hour < end_h:
                available = [mode for mode in candidates if mode in modes]
                if available:
                    return random.choice(available)
        return random.choice(modes)

    return random.choice(modes)


async def advance_to_next_mode(mac: Optional[str], config: dict) -> str:
    modes = config.get("modes", DEFAULT_MODES)
    if not modes:
        return "STOIC"

    state = await get_device_state(mac) if mac else None
    current = state.get("last_persona", "") if state else ""
    idx = (modes.index(current) + 1) % len(modes) if current in modes else 0
    persona = modes[idx]
    if mac:
        await set_cycle_index(mac, idx + 1)
    return persona


async def consume_pending_mode(mac: str) -> Optional[str]:
    try:
        state = await get_device_state(mac)
        if state and state.get("pending_mode"):
            mode = state["pending_mode"]
            await update_device_state(mac, pending_mode="")
            return mode
    except (OSError, ValueError, TypeError):
        logger.warning("[PENDING_MODE] Failed to consume for %s", mac, exc_info=True)
    return None


async def resolve_mode(
    mac: Optional[str],
    config: Optional[dict],
    persona_override: Optional[str],
    *,
    force_next: bool = False,
) -> str:
    from core.mode_registry import get_registry

    registry = get_registry()
    # Always pass mac to is_supported to ensure device isolation
    if mac and not persona_override:
        pending = await consume_pending_mode(mac)
        if pending and registry.is_supported(pending.upper(), mac):
            return pending.upper()

    if persona_override and registry.is_supported(persona_override.upper(), mac):
        return persona_override.upper()

    if config:
        if force_next:
            return await advance_to_next_mode(mac, config)
        return await choose_persona_from_config(config)

    return random.choice(["STOIC", "ROAST", "ZEN", "DAILY"])


async def build_image(
    v: float,
    mac: Optional[str],
    persona_override: Optional[str] = None,
    *,
    screen_w: int,
    screen_h: int,
    force_next: bool = False,
    skip_cache: bool = False,
    preview_city_override: Optional[str] = None,
    preview_mode_override: Optional[dict] = None,
    preview_memo_text: Optional[str] = None,
    preview_memo_settings: Optional[dict] = None,
    preview_ui_language: Optional[str] = None,
    current_user_id: Optional[int] = None,
    user_api_key: Optional[str] = None,
    intent_only: bool = False,
    colors: int = 2,
):
    from core.mode_registry import get_registry

    battery_pct = calc_battery_pct(v)
    config = await get_active_config(mac) if mac else None
    persona = await resolve_mode(mac, config, persona_override, force_next=force_next)
    owner_user_id: Optional[int] = None
    if mac:
        from core.config_store import get_device_owner

        owner = await get_device_owner(mac)
        if owner:
            try:
                owner_user_id = int(owner.get("user_id"))
            except (TypeError, ValueError):
                owner_user_id = None

    registry = get_registry()
    
    # Load device owner's custom modes if needed (for device rendering)
    # Only load modes for the specific device to avoid loading modes from other devices
    if mac and not registry.is_supported(persona, mac):
        if owner_user_id:
            await registry.load_user_custom_modes(owner_user_id, mac)
            logger.debug(f"[BUILD_IMAGE] Loaded custom modes for device owner {owner_user_id} (device {mac})")
        # Fallback: configured persona may reference a deleted/missing custom mode.
        if not registry.is_supported(persona, mac):
            cfg_modes = config.get("modes", []) if isinstance(config, dict) else []
            fallback_persona = None
            if isinstance(cfg_modes, list):
                for m in cfg_modes:
                    cand = str(m).upper().strip()
                    if registry.is_supported(cand, mac):
                        fallback_persona = cand
                        break
            persona = fallback_persona or "STOIC"
            logger.warning(
                "[BUILD_IMAGE] Unsupported persona for %s, fallback to %s",
                mac,
                persona,
            )
    
    # For Web preview without mac: load all custom modes for the current user
    # Note: This may cause conflicts if user has same mode_id on different devices
    # but we unregister before loading, so the last loaded will take precedence
    if not mac and current_user_id is not None and not registry.is_supported(persona):
        await registry.load_user_custom_modes(current_user_id, None)
        logger.debug(f"[BUILD_IMAGE] Loaded all custom modes for user {current_user_id} (Web preview without device)")
    
    mode_info = registry.get_mode_info(persona)
    is_mode_cacheable = bool(mode_info.cacheable) if mode_info else True

    # Instance-level AI settings are used by browser previews and firmware alike.
    from core.local_store import get_local_llm_config
    local_cfg = await get_local_llm_config()
    usage_source = "server_api_key"
    if local_cfg:
        config = dict(config or {})
        field_map = {
            "llm_access_mode": "llm_access_mode", "provider": "llm_provider",
            "model": "llm_model", "api_key": "user_api_key",
            "image_provider": "image_provider", "image_model": "image_model",
            "image_api_key": "user_image_api_key", "image_base_url": "image_base_url",
        }
        for source, target in field_map.items():
            if local_cfg.get(source):
                config[target] = local_cfg[source]
        if local_cfg.get("llm_access_mode") == "custom_openai" and local_cfg.get("base_url"):
            config["llm_base_url"] = local_cfg["base_url"]
        usage_source = "local_api_key"
    if user_api_key and user_api_key.strip():
        config = dict(config or {})
        config["user_api_key"] = user_api_key.strip()
        usage_source = "request_api_key"

    def needs_llm(content: dict) -> bool:
        if not isinstance(content, dict):
            return False
        if content.get("type") in {"llm", "llm_json", "image_gen"}:
            return True
        return any(needs_llm(step) for step in content.get("steps", []) if isinstance(step, dict))

    json_mode = registry.get_json_mode(persona, mac)
    requires_llm = bool(json_mode and needs_llm(json_mode.definition.get("content", {})))

    if preview_city_override or preview_mode_override or preview_memo_text or preview_memo_settings:
        config = copy.deepcopy(config or {})
        mode_overrides = dict(config.get("mode_overrides") or {})
        current_mode_override = dict(mode_overrides.get(persona) or {})
        if preview_city_override:
            config["city"] = preview_city_override
            current_mode_override["city"] = preview_city_override
        if isinstance(preview_mode_override, dict) and preview_mode_override:
            current_mode_override.update(preview_mode_override)
        mode_overrides[persona] = current_mode_override
        config["mode_overrides"] = mode_overrides
        config["modeOverrides"] = mode_overrides
        if persona == "MEMO":
            memo_text = current_mode_override.get("memo_text")
            if isinstance(memo_text, str) and memo_text.strip():
                config["memo_text"] = memo_text.strip()
                config["memoText"] = memo_text.strip()
            if isinstance(preview_memo_text, str) and preview_memo_text.strip():
                memo_clean = preview_memo_text.strip()
                current_mode_override["memo_text"] = memo_clean
                mode_overrides[persona] = current_mode_override
                config["mode_overrides"] = mode_overrides
                config["modeOverrides"] = mode_overrides
                config["memo_text"] = memo_clean
                config["memoText"] = memo_clean
            if isinstance(preview_memo_settings, dict) and preview_memo_settings:
                ms = dict(current_mode_override.get("mode_settings") or {})
                ms.update(preview_memo_settings)
                current_mode_override["mode_settings"] = ms
                mode_overrides[persona] = current_mode_override
                config["mode_overrides"] = mode_overrides
                config["modeOverrides"] = mode_overrides

    # 无设备预览（/preview 等）：按页面站点语言（中/英）决定 mode_language。
    # 设备配置页预览（有 mac）：沿用 configs 中保存的 mode_language，不被 ui_language 覆盖。
    if not mac and preview_ui_language in ("zh", "en"):
        config = copy.deepcopy(config or {})
        config["mode_language"] = preview_ui_language
        config["modeLanguage"] = preview_ui_language

    cache_hit = False
    img = None

    # ── Preview Cache: Check cache for preview requests (no mac required) ──
    mode_override_hash = None
    if preview_mode_override:
        # Generate a hash of the mode override config for cache key
        mode_override_hash = hashlib.md5(
            json.dumps(preview_mode_override, sort_keys=True).encode()
        ).hexdigest()[:12]

    if not mac and is_mode_cacheable and not skip_cache:
        # This is a preview request without device mac - use preview cache
        preview_cache_key = content_cache._get_preview_cache_key(persona, screen_w, screen_h, preview_city_override, mode_override_hash, preview_ui_language)
        cached_img = await content_cache.get_preview(
            persona,
            screen_w,
            screen_h,
            city_override=preview_city_override,
            mode_override_hash=mode_override_hash,
            ui_language=preview_ui_language,
        )
        if cached_img:
            cache_hit = True
            img = cached_img

    if mac and config and is_mode_cacheable and not skip_cache:
        if not intent_only:
            cacheable_modes = get_registry().get_cacheable_ids()
            await content_cache.check_and_regenerate_all(mac, config, v, screen_w, screen_h, colors=colors, cacheable_modes=cacheable_modes)
        cached_img = await content_cache.get(
            mac,
            persona,
            config,
            screen_w=screen_w,
            screen_h=screen_h,
        )
        if cached_img:
            cache_hit = True
            img = cached_img
        else:
            logger.info("[CACHE MISS] %s:%s - Generating content", mac, persona)
    elif not mac:
        # Preview request without device mac
        if skip_cache:
            logger.info("[PREVIEW] Skip cache for %s:%s", mac, persona)
        # img is already set from preview cache above, don't overwrite
    else:
        if skip_cache:
            logger.info("[PREVIEW] Skip cache for %s:%s", mac, persona)
        img = None

    content_data = None
    content_fallback = False

    if intent_only:
        return img, persona, cache_hit, content_fallback, False, False, requires_llm, usage_source

    if not cache_hit:
        effective_cfg = get_effective_mode_config(config, persona)
        location_args = extract_location_settings(effective_cfg, fallback_city=DEFAULT_CITY)
        date_ctx, weather = await asyncio.gather(
            get_date_context(),
            get_weather(**location_args),
        )
        img, content_data = await generate_and_render(
            persona,
            config,
            date_ctx,
            weather,
            battery_pct,
            screen_w=screen_w,
            screen_h=screen_h,
            mac=mac or "",
            colors=colors,
        )
        if isinstance(content_data, dict):
            logger.debug(
                "[BUILD_IMAGE] content_data keys: %s, _is_fallback=%s, _used_fallback=%s, _llm_ok=%s",
                list(content_data.keys()),
                content_data.get("_is_fallback"),
                content_data.get("_used_fallback"),
                content_data.get("_llm_ok"),
            )
            if content_data.get("_is_fallback") is True:
                content_fallback = True
            elif content_data.get("_used_fallback") is True:
                content_fallback = True
            else:
                jm = get_registry().get_json_mode(persona, mac)
                if jm and jm.definition.get("content", {}).get("type") == "image_gen":
                    content_fallback = not bool(content_data.get("image_url"))

        if mac and config and is_mode_cacheable:
            await content_cache.set(mac, persona, img, screen_w, screen_h)

        # ── Preview Cache: Save generated image for preview requests ──
        if not mac and is_mode_cacheable and not skip_cache and img is not None:
            await content_cache.set_preview(
                persona,
                img,
                screen_w,
                screen_h,
                city_override=preview_city_override,
                mode_override_hash=mode_override_hash,
                ui_language=preview_ui_language,
            )

    if mac:
        await update_device_state(
            mac,
            last_persona=persona,
            last_refresh_at=datetime.now().isoformat(),
        )

    if mac and content_data:
        try:
            await save_render_content(mac, persona, content_data)
        except (OSError, ValueError, TypeError):
            logger.warning("[CONTENT] Failed to save content for %s:%s", mac, persona, exc_info=True)

    # 检查 API key 是否无效
    api_key_invalid = False
    if isinstance(content_data, dict) and content_data.get("_api_key_invalid") is True:
        api_key_invalid = True
        logger.warning(
            "[API_KEY] User provided API key is invalid or expired for mac=%s, mode=%s",
            mac,
            persona,
        )
        # 对于设备端，返回提示图片；对于 Web 预览，返回 api_key_invalid 标志让接口处理
        if mac:
            img = _render_api_key_invalid_image(screen_w, screen_h)
            await update_device_state(
                mac,
                last_persona=persona,
                last_refresh_at=datetime.now().isoformat(),
            )

    return img, persona, cache_hit, content_fallback, False, api_key_invalid, requires_llm, usage_source


async def log_render_stats(
    mac: str,
    persona: str,
    cache_hit: bool,
    elapsed_ms: int,
    *,
    voltage: float = 3.3,
    rssi: Optional[int] = None,
    status: str = "success",
    is_fallback: bool = False,
):
    try:
        await log_render(mac, persona, cache_hit, elapsed_ms, status, is_fallback=is_fallback)
        await log_heartbeat(mac, voltage, rssi)
    except (OSError, ValueError, TypeError):
        logger.warning("[STATS] Failed to log render stats for %s", mac, exc_info=True)


async def resolve_preview_voltage(v: Optional[float], mac: Optional[str]) -> float:
    if v is not None:
        return v
    if mac:
        latest_voltage = await get_latest_battery_voltage(mac)
        if latest_voltage is not None:
            return latest_voltage
    return 3.3


def resolve_refresh_minutes_for_device_state(config: Optional[dict], state: Optional[dict]) -> int:
    refresh_minutes_raw = config.get("refresh_interval") if config else DEFAULT_REFRESH_INTERVAL
    try:
        refresh_minutes = int(refresh_minutes_raw)
    except (TypeError, ValueError):
        refresh_minutes = DEFAULT_REFRESH_INTERVAL
    if refresh_minutes <= 0:
        refresh_minutes = DEFAULT_REFRESH_INTERVAL

    expected_refresh_raw = state.get("expected_refresh_min", 0) if state else 0
    try:
        expected_refresh = int(expected_refresh_raw)
    except (TypeError, ValueError):
        expected_refresh = 0
    if expected_refresh > 0:
        refresh_minutes = expected_refresh
    return refresh_minutes


def reconnect_threshold_seconds(refresh_minutes: int) -> int:
    base_seconds = max(1, int(refresh_minutes)) * 60
    return max(base_seconds + 30, int(base_seconds * 1.5))


def build_firmware_manifest(version: str, download_url: str, chip_family: str = FIRMWARE_CHIP_FAMILY) -> dict:
    return {
        "name": "InkSight",
        "version": version,
        "builds": [
            {
                "chipFamily": chip_family,
                "parts": [{"path": download_url, "offset": 0}],
            }
        ],
    }


def chip_family_from_asset_name(asset_name: str) -> str:
    name = (asset_name or "").lower()
    if "_s3" in name or "esp32s3" in name or "esp32-s3" in name:
        return "ESP32-S3"
    if "wroom32e" in name or "_esp32" in name:
        return "ESP32"
    if "_c3" in name or "esp32c3" in name:
        return "ESP32-C3"
    return FIRMWARE_CHIP_FAMILY


def pick_firmware_asset(assets: list[dict]) -> Optional[dict]:
    preferred = [
        asset
        for asset in assets
        if asset.get("name", "").endswith(".bin")
        and "inksight-firmware-" in asset.get("name", "")
    ]
    if preferred:
        return preferred[0]
    fallback = [asset for asset in assets if asset.get("name", "").endswith(".bin")]
    return fallback[0] if fallback else None


def expand_firmware_release_assets(release: dict) -> list[dict]:
    tag_name = release.get("tag_name", "")
    version = tag_name.lstrip("v") if tag_name else "unknown"
    published_at = release.get("published_at")
    items = []
    for asset in release.get("assets", []):
        asset_name = asset.get("name", "")
        if not asset_name.endswith(".bin"):
            continue
        download_url = asset.get("browser_download_url")
        if not download_url:
            continue
        chip_family = chip_family_from_asset_name(asset_name)
        items.append(
            {
                "version": version,
                "tag": tag_name,
                "published_at": published_at,
                "download_url": download_url,
                "size_bytes": asset.get("size"),
                "chip_family": chip_family,
                "asset_name": asset_name,
                "manifest": build_firmware_manifest(version, download_url, chip_family),
            }
        )
    preferred = [item for item in items if "inksight-firmware-" in item["asset_name"]]
    return preferred or items


async def load_firmware_releases(force_refresh: bool = False) -> dict:
    now = time.time()
    async with _firmware_release_cache_lock:
        if (
            not force_refresh
            and _firmware_release_cache["payload"] is not None
            and _firmware_release_cache["expires_at"] > now
        ):
            cached_payload = dict(_firmware_release_cache["payload"])
            cached_payload["cached"] = True
            return cached_payload

        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "inksight-firmware-api",
        }
        github_token = os.getenv("GITHUB_TOKEN")
        if github_token:
            headers["Authorization"] = f"Bearer {github_token}"

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(GITHUB_RELEASES_API, headers=headers)
        if resp.status_code >= 400:
            message = f"GitHub releases API error: {resp.status_code}"
            try:
                details = resp.json().get("message")
                if details:
                    message = f"{message} - {details}"
            except (ValueError, TypeError, json.JSONDecodeError):
                logger.warning("[FIRMWARE] Failed to parse GitHub error payload", exc_info=True)
            raise RuntimeError(message)

        releases = []
        for release in resp.json():
            if release.get("draft"):
                continue
            releases.extend(expand_firmware_release_assets(release))

        payload = {
            "source": "github_releases",
            "repo": f"{GITHUB_OWNER}/{GITHUB_REPO}",
            "cached": False,
            "count": len(releases),
            "releases": releases,
        }
        _firmware_release_cache["payload"] = payload
        _firmware_release_cache["expires_at"] = now + FIRMWARE_RELEASE_CACHE_TTL
        return payload


async def validate_firmware_url(url: str) -> dict:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("firmware URL must start with http:// or https://")
    if not parsed.netloc:
        raise ValueError("firmware URL host is missing")
    if not parsed.path.lower().endswith(".bin"):
        raise ValueError("firmware URL should point to a .bin file")

    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        try:
            resp = await client.head(url)
        except httpx.HTTPError:
            logger.warning("[FIRMWARE] HEAD failed for %s, falling back to ranged GET", url, exc_info=True)
            resp = await client.get(url, headers={"Range": "bytes=0-0"})
    if resp.status_code >= 400:
        raise RuntimeError(f"firmware URL is not reachable: {resp.status_code}")

    return {
        "ok": True,
        "reachable": True,
        "status_code": resp.status_code,
        "final_url": str(resp.url),
        "content_type": resp.headers.get("content-type"),
        "content_length": resp.headers.get("content-length"),
    }


def normalize_pushed_preview(image_bytes: bytes, *, width: int, height: int) -> bytes:
    with Image.open(io.BytesIO(image_bytes)) as incoming:
        img = incoming.convert("1")
        if img.size != (width, height):
            img = img.resize((width, height), Image.NEAREST)
        return image_to_bmp_bytes(img)


def _render_api_key_invalid_image(screen_w: int, screen_h: int) -> Image.Image:
    """渲染 API key 无效提示图（1-bit），对 ESP32 固件保持兼容。

    始终返回 mode=\"1\" 的黑白图像，调用方按 BMP 返回给设备（HTTP 200）。
    """
    img = Image.new("1", (screen_w, screen_h), 1)  # 1 = 白色背景
    draw = ImageDraw.Draw(img)
    message = "API key 无效或已过期，请检查设备配置"
    try:
        font = load_font("noto_serif_regular", 12)
    except Exception:  # pragma: no cover - 极端环境下回退
        font = None
    try:
        if font:
            bbox = draw.textbbox((0, 0), message, font=font)
            text_w = bbox[2] - bbox[0]
            text_h = bbox[3] - bbox[1]
        else:
            text_w = len(message) * 6
            text_h = 10
        x = (screen_w - text_w) // 2
        y = (screen_h - text_h) // 2
        draw.text((x, y), message, fill=0, font=font)  # 0 = 黑色文字
    except Exception:
        logger.warning("[RENDER] Failed to render API key invalid message", exc_info=True)
    return img




def _render_device_unbound_image(screen_w: int, screen_h: int, mac: str) -> Image.Image:
    img = Image.new("1", (screen_w, screen_h), 1)
    draw = ImageDraw.Draw(img)
    title = "欢迎使用 InkSight"
    pair_line = f"设备：{mac}"
    hint = "请在本地控制台的设备页面添加此设备"
    try:
        title_font = load_font("noto_serif_regular", 20)
        body_font = load_font("noto_serif_regular", 14)
    except Exception:
        title_font = None
        body_font = None
    try:
        if title_font:
            title_bbox = draw.textbbox((0, 0), title, font=title_font)
            title_w = title_bbox[2] - title_bbox[0]
            title_h = title_bbox[3] - title_bbox[1]
        else:
            title_w = len(title) * 10
            title_h = 18
        if body_font:
            pair_bbox = draw.textbbox((0, 0), pair_line, font=body_font)
            hint_bbox = draw.textbbox((0, 0), hint, font=body_font)
            pair_w = pair_bbox[2] - pair_bbox[0]
            pair_h = pair_bbox[3] - pair_bbox[1]
            hint_w = hint_bbox[2] - hint_bbox[0]
            hint_h = hint_bbox[3] - hint_bbox[1]
        else:
            pair_w = len(pair_line) * 7
            pair_h = 12
            hint_w = len(hint) * 7
            hint_h = 12
        spacing = 18
        total_h = title_h + pair_h + hint_h + spacing * 2
        y = max(16, (screen_h - total_h) // 2)
        draw.text((max(0, (screen_w - title_w) // 2), y), title, fill=0, font=title_font)
        y += title_h + spacing
        draw.text((max(0, (screen_w - pair_w) // 2), y), pair_line, fill=0, font=body_font)
        y += pair_h + spacing
        draw.text((max(0, (screen_w - hint_w) // 2), y), hint, fill=0, font=body_font)
    except Exception:
        logger.warning("[RENDER] Failed to render device unbound message", exc_info=True)
    return img
