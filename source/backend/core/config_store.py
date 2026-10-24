from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import hmac
import aiosqlite
from datetime import datetime, timedelta
from typing import Optional

logger = logging.getLogger(__name__)

from .db import _MAIN_DB_PATH, get_main_db  # ← 复用 db.py 的路径，与 static_store 保持一致
from migrations import run_main_db_migrations
from .config import (
    DEFAULT_CITY,
    DEFAULT_LLM_PROVIDER,
    DEFAULT_LLM_MODEL,
    DEFAULT_IMAGE_PROVIDER,
    DEFAULT_IMAGE_MODEL,
    DEFAULT_LANGUAGE,
    DEFAULT_CONTENT_TONE,
    DEFAULT_MODES,
    DEFAULT_REFRESH_STRATEGY,
    DEFAULT_REFRESH_INTERVAL,
)

# 历史兼容：保留 DB_PATH 别名供外部使用
DB_PATH = _MAIN_DB_PATH


async def init_db():
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS configs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mac TEXT NOT NULL,
                nickname TEXT DEFAULT '',
                modes TEXT DEFAULT 'STOIC,ROAST,ZEN,DAILY',
                refresh_strategy TEXT DEFAULT 'random',
                character_tones TEXT DEFAULT '',
                language TEXT DEFAULT 'zh',
                mode_language TEXT DEFAULT '',
                content_tone TEXT DEFAULT 'neutral',
                city TEXT DEFAULT '杭州',
                latitude REAL,
                longitude REAL,
                timezone TEXT DEFAULT '',
                admin1 TEXT DEFAULT '',
                country TEXT DEFAULT '',
                refresh_interval INTEGER DEFAULT 60,
                llm_provider TEXT DEFAULT 'deepseek',
                llm_model TEXT DEFAULT 'deepseek-chat',
                image_provider TEXT DEFAULT 'aliyun',
                image_model TEXT DEFAULT 'qwen-image-max',
                countdown_events TEXT DEFAULT '[]',
                time_slot_rules TEXT DEFAULT '[]',
                memo_text TEXT DEFAULT '',
                mode_overrides TEXT DEFAULT '{}',
                focus_listening INTEGER DEFAULT 0,
                always_active INTEGER DEFAULT 0,
                is_active INTEGER DEFAULT 1,
                created_at TEXT NOT NULL
            )
        """)

        await db.execute("CREATE INDEX IF NOT EXISTS idx_configs_mac ON configs(mac)")

        _EXPECTED_COLUMNS = {
            "llm_provider": "TEXT DEFAULT 'deepseek'",
            "llm_model": "TEXT DEFAULT 'deepseek-chat'",
            "image_provider": "TEXT DEFAULT 'aliyun'",
            "image_model": "TEXT DEFAULT 'qwen-image-max'",
            "countdown_events": "TEXT DEFAULT '[]'",
            "time_slot_rules": "TEXT DEFAULT '[]'",
            "memo_text": "TEXT DEFAULT ''",
            "mode_overrides": "TEXT DEFAULT '{}'",
            "mode_language": "TEXT DEFAULT ''",
            "focus_listening": "INTEGER DEFAULT 0",
            "always_active": "INTEGER DEFAULT 0",
            "latitude": "REAL",
            "longitude": "REAL",
            "timezone": "TEXT DEFAULT ''",
            "admin1": "TEXT DEFAULT ''",
            "country": "TEXT DEFAULT ''",
        }
        try:
            cursor = await db.execute("PRAGMA table_info(configs)")
            existing = {row[1] for row in await cursor.fetchall()}
            for col, typedef in _EXPECTED_COLUMNS.items():
                if col not in existing:
                    await db.execute(f"ALTER TABLE configs ADD COLUMN {col} {typedef}")
                    logger.info("[MIGRATION] Added column configs.%s", col)
            await db.commit()
        except Exception as e:
            logger.warning("[MIGRATION] Failed to add missing columns: %s", e, exc_info=True)
            await db.rollback()

        # Device state table for persisting runtime state (cycle_index, etc.)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS device_state (
                mac TEXT PRIMARY KEY,
                cycle_index INTEGER DEFAULT 0,
                last_persona TEXT DEFAULT '',
                last_refresh_at TEXT DEFAULT '',
                pending_refresh INTEGER DEFAULT 0,
                pending_mode TEXT DEFAULT '',
                last_state_poll_at TEXT DEFAULT '',
                auth_token TEXT DEFAULT '',
                runtime_mode TEXT DEFAULT 'interval',
                expected_refresh_min INTEGER DEFAULT 0,
                last_reconnect_regen_at TEXT DEFAULT '',
                alert_token TEXT DEFAULT '',
                alert_token_created_at TEXT DEFAULT '',
                updated_at TEXT NOT NULL
            )
        """)
        # Migration: add focus_listening column if missing
        try:
            cursor = await db.execute("PRAGMA table_info(configs)")
            columns = await cursor.fetchall()
            names = [c[1] for c in columns]
            if "focus_listening" not in names:
                await db.execute("ALTER TABLE configs ADD COLUMN focus_listening INTEGER DEFAULT 0")
                await db.commit()
        except Exception:
            logger.warning("[MIGRATION] Failed to add focus_listening column", exc_info=True)

        # Migration: add alert token columns if missing
        try:
            cursor = await db.execute("PRAGMA table_info(device_state)")
            columns = await cursor.fetchall()
            names = [c[1] for c in columns]
            if "alert_token" not in names:
                await db.execute("ALTER TABLE device_state ADD COLUMN alert_token TEXT DEFAULT ''")
            if "alert_token_created_at" not in names:
                await db.execute("ALTER TABLE device_state ADD COLUMN alert_token_created_at TEXT DEFAULT ''")
            await db.commit()
        except Exception:
            logger.warning("[MIGRATION] Failed to add alert token columns", exc_info=True)

        # chip_family 列迁移（OTA 固件选型用）
        try:
            cursor = await db.execute("PRAGMA table_info(device_state)")
            columns = await cursor.fetchall()
            names = [c[1] for c in columns]
            if "chip_family" not in names:
                await db.execute("ALTER TABLE device_state ADD COLUMN chip_family TEXT DEFAULT ''")
                await db.commit()
        except Exception:
            logger.warning("[MIGRATION] Failed to add chip_family column", exc_info=True)

        # Migration: add photo_frame_index column if missing
        try:
            cursor = await db.execute("PRAGMA table_info(device_state)")
            columns = await cursor.fetchall()
            names = [c[1] for c in columns]
            if "photo_frame_index" not in names:
                await db.execute("ALTER TABLE device_state ADD COLUMN photo_frame_index INTEGER DEFAULT 0")
            await db.commit()
        except Exception:
            logger.warning("[MIGRATION] Failed to add photo_frame_index column", exc_info=True)

        # Migration: add OTA columns if missing
        try:
            cursor = await db.execute("PRAGMA table_info(device_state)")
            columns = await cursor.fetchall()
            names = [c[1] for c in columns]
            if "pending_ota" not in names:
                await db.execute("ALTER TABLE device_state ADD COLUMN pending_ota INTEGER DEFAULT 0")
            if "ota_version" not in names:
                await db.execute("ALTER TABLE device_state ADD COLUMN ota_version TEXT DEFAULT ''")
            if "ota_url" not in names:
                await db.execute("ALTER TABLE device_state ADD COLUMN ota_url TEXT DEFAULT ''")
            if "ota_progress" not in names:
                await db.execute("ALTER TABLE device_state ADD COLUMN ota_progress INTEGER DEFAULT 0")
            if "ota_result" not in names:
                await db.execute("ALTER TABLE device_state ADD COLUMN ota_result TEXT DEFAULT ''")
            await db.commit()
        except Exception:
            logger.warning("[MIGRATION] Failed to add OTA columns", exc_info=True)

        await run_main_db_migrations(
            db, defaults={"image_provider": DEFAULT_IMAGE_PROVIDER, "image_model": DEFAULT_IMAGE_MODEL},
        )
        from .local_store import init_local_store
        await init_local_store(db)
        await db.commit()
    try:
        from .vocab_store import seed_builtin_vocab
        await seed_builtin_vocab()
    except Exception:
        logger.warning("[VOCAB] Failed to seed builtin vocabulary", exc_info=True)


# Legacy Python names retain client/device compatibility; none uses an account.
from .local_store import (
    get_local_device, list_local_devices, add_local_device, remove_local_device,
    get_local_llm_config, save_local_llm_config, delete_local_llm_config,
    get_local_preferences, save_local_preferences,
)

async def get_device_membership(mac: str, user_id: int = 1, *, include_pending: bool = False):
    return await get_local_device(mac)

async def get_device_owner(mac: str):
    return await get_local_device(mac)

async def has_active_membership(mac: str, user_id: int = 1) -> bool:
    return await get_local_device(mac) is not None

async def is_device_owner(mac: str, user_id: int = 1) -> bool:
    return await has_active_membership(mac)

async def bind_device(user_id: int, mac: str, nickname: str = "") -> dict:
    return await add_local_device(mac, nickname)

async def unbind_device(user_id: int, mac: str, force: bool = False) -> str:
    return "ok" if await remove_local_device(mac) else "not_found"

async def get_user_devices(user_id: int = 1) -> list[dict]:
    return await list_local_devices()

async def get_user_llm_config(user_id: int = 1):
    return await get_local_llm_config()

async def save_user_llm_config(user_id: int, llm_access_mode: str = "preset", provider: str = "deepseek", model: str = "", api_key: str = "", base_url: str = "", image_provider: str = "aliyun", image_model: str = "", image_api_key: str = "", image_base_url: str = "") -> bool:
    return await save_local_llm_config({key: value for key, value in locals().items() if key != "user_id"})

async def delete_user_llm_config(user_id: int = 1) -> bool:
    return await delete_local_llm_config()

async def get_user_preferences(user_id: int = 1) -> dict:
    return await get_local_preferences()

async def save_user_preferences(user_id: int, data: dict) -> dict:
    return await save_local_preferences(data)


async def save_config(mac: str, data: dict) -> int:
    now = datetime.now().isoformat()
    refresh_strategy = data.get("refreshStrategy", "random")
    always_active = 1 if bool(data.get("always_active", False)) else 0
    logger.info(
        "[CONFIG SAVE] mac=%s, refreshStrategy=%s, always_active=%s, modes=%s",
        mac,
        refresh_strategy,
        always_active,
        data.get("modes"),
    )

    db = await get_main_db()
    prev = await get_active_config(mac)
    await db.execute("UPDATE configs SET is_active = 0 WHERE mac = ?", (mac,))

    countdown_events_json = json.dumps(
        data.get("countdownEvents", []) or data.get("countdown_events", []), ensure_ascii=False
    )
    time_slot_rules_json = json.dumps(
        data.get("timeSlotRules", []) or data.get("time_slot_rules", []), ensure_ascii=False
    )
    memo_text = data.get("memoText", "")
    mode_overrides_json = json.dumps(
        data.get("modeOverrides", {}) or data.get("mode_overrides", {}), ensure_ascii=False
    )
    # 注意：API key 不再保存到设备配置中，改为使用本地实例的 AI 配置（local_llm_config 表）
    # 这里依赖 configs 表的默认值将 is_active 设为 1，因此不再显式写入该列，避免列数不匹配。
    cursor = await db.execute(
        """INSERT INTO configs
           (mac, nickname, modes, refresh_strategy, character_tones,
            language, mode_language, content_tone, city, latitude, longitude, timezone, admin1, country,
            refresh_interval, llm_provider, llm_model, image_provider, image_model,
            countdown_events, time_slot_rules, memo_text, mode_overrides, focus_listening, always_active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            mac,
            data.get("nickname", ""),
            ",".join(data.get("modes", DEFAULT_MODES)),
            refresh_strategy,
            ",".join(data.get("characterTones", [])),
            data.get("language", DEFAULT_LANGUAGE),
            data.get("modeLanguage", ""),
            data.get("contentTone", DEFAULT_CONTENT_TONE),
            data.get("city", DEFAULT_CITY),
            data.get("latitude"),
            data.get("longitude"),
            data.get("timezone", ""),
            data.get("admin1", ""),
            data.get("country", ""),
            data.get("refreshInterval", DEFAULT_REFRESH_INTERVAL),
            data.get("llmProvider", DEFAULT_LLM_PROVIDER),
            data.get("llmModel", DEFAULT_LLM_MODEL),
            data.get("imageProvider", DEFAULT_IMAGE_PROVIDER),
            data.get("imageModel", DEFAULT_IMAGE_MODEL),
            countdown_events_json,
            time_slot_rules_json,
            memo_text,
            mode_overrides_json,
            1 if bool(data.get("is_focus_listening", False)) else 0,
            always_active,
            now,
        ),
    )
    config_id = cursor.lastrowid

    # Keep only the latest 5 configs per device
    await db.execute(
        """DELETE FROM configs
           WHERE mac = ? AND id NOT IN (
               SELECT id FROM configs
               WHERE mac = ?
               ORDER BY created_at DESC
               LIMIT 5
           )""",
        (mac, mac),
    )

    await db.commit()
    logger.info("[CONFIG SAVE] Saved as id=%s, is_active=1, always_active=%s", config_id, always_active)
    return config_id


async def update_focus_listening(mac: str, enabled: bool) -> bool:
    """轻量更新 focus_listening：复制当前 active config 并仅修改开关字段。"""
    normalized_mac = mac.upper()
    db = await get_main_db()
    prev = await get_active_config(normalized_mac)
    if not prev:
        return False

    for attempt in range(5):
        try:
            await db.execute("UPDATE configs SET is_active = 0 WHERE mac = ?", (normalized_mac,))
            break
        except Exception as e:
            if "database is locked" in str(e).lower():
                await asyncio.sleep(0.15 * (attempt + 1))
                continue
            raise
    else:
        return False

    prev_modes = prev.get("modes", DEFAULT_MODES)
    modes_str = ",".join(prev_modes) if isinstance(prev_modes, list) else str(prev_modes or ",".join(DEFAULT_MODES))
    prev_tones = prev.get("character_tones", [])
    tones_str = ",".join(prev_tones) if isinstance(prev_tones, list) else str(prev_tones or "")
    ce_val = prev.get("countdown_events", "[]")
    countdown_events_json = ce_val if isinstance(ce_val, str) else json.dumps(ce_val, ensure_ascii=False)
    tsr_val = prev.get("time_slot_rules", "[]")
    time_slot_rules_json = tsr_val if isinstance(tsr_val, str) else json.dumps(tsr_val, ensure_ascii=False)
    mo_val = prev.get("mode_overrides", "{}")
    mode_overrides_json = mo_val if isinstance(mo_val, str) else json.dumps(mo_val, ensure_ascii=False)

    for attempt in range(5):
        try:
            await db.execute(
                """INSERT INTO configs
                   (mac, nickname, modes, refresh_strategy, character_tones,
                    language, mode_language, content_tone, city, refresh_interval, llm_provider, llm_model, image_provider, image_model,
                    countdown_events, time_slot_rules, memo_text, mode_overrides, focus_listening, always_active, is_active, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)""",
                (
                    normalized_mac,
                    prev.get("nickname", "") or "",
                    modes_str,
                    prev.get("refresh_strategy", DEFAULT_REFRESH_STRATEGY),
                    tones_str,
                    prev.get("language", DEFAULT_LANGUAGE),
                    prev.get("mode_language", ""),
                    prev.get("content_tone", DEFAULT_CONTENT_TONE),
                    prev.get("city", DEFAULT_CITY),
                    int(prev.get("refresh_interval", DEFAULT_REFRESH_INTERVAL) or DEFAULT_REFRESH_INTERVAL),
                    prev.get("llm_provider", DEFAULT_LLM_PROVIDER),
                    prev.get("llm_model", DEFAULT_LLM_MODEL),
                    prev.get("image_provider", DEFAULT_IMAGE_PROVIDER),
                    prev.get("image_model", DEFAULT_IMAGE_MODEL),
                    countdown_events_json,
                    time_slot_rules_json,
                    str(prev.get("memo_text", "") or ""),
                    mode_overrides_json,
                    1 if enabled else 0,
                    1 if bool(prev.get("always_active", False)) else 0,
                    datetime.now().isoformat(),
                ),
            )
            await db.execute(
                """DELETE FROM configs
                   WHERE mac = ? AND id NOT IN (
                       SELECT id FROM configs
                       WHERE mac = ?
                       ORDER BY created_at DESC
                       LIMIT 5
                   )""",
                (normalized_mac, normalized_mac),
            )
            await db.commit()
            return True
        except Exception as e:
            try:
                await db.rollback()
            except Exception:
                pass
            if "database is locked" in str(e).lower():
                await asyncio.sleep(0.2 * (attempt + 1))
                continue
            raise
    return False


async def get_or_create_alert_token(mac: str, regenerate: bool = False) -> str:
    normalized_mac = mac.upper()
    now = datetime.now().isoformat()
    db = await get_main_db()
    cursor = await db.execute("SELECT alert_token FROM device_state WHERE mac = ?", (normalized_mac,))
    row = await cursor.fetchone()
    existing = (row[0] if row and row[0] else "").strip() if row else ""
    if existing and not regenerate:
        return existing
    token = secrets.token_urlsafe(32)
    await db.execute(
        """INSERT INTO device_state (mac, alert_token, alert_token_created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(mac) DO UPDATE SET alert_token = ?, alert_token_created_at = ?, updated_at = ?""",
        (normalized_mac, token, now, now, token, now, now),
    )
    await db.commit()
    return token


async def validate_alert_token(mac: str, token: str) -> bool:
    normalized_mac = mac.upper()
    provided = (token or "").strip()
    if not provided:
        return False
    db = await get_main_db()
    cursor = await db.execute("SELECT alert_token FROM device_state WHERE mac = ?", (normalized_mac,))
    row = await cursor.fetchone()
    expected = (row[0] if row and row[0] else "").strip() if row else ""
    if not expected:
        return False
    return hmac.compare_digest(expected, provided)


def _row_to_dict(row, columns) -> dict:
    d = dict(zip(columns, row))
    d["modes"] = [m for m in d["modes"].split(",") if m]
    d["character_tones"] = [t for t in d["character_tones"].split(",") if t]
    d["refreshStrategy"] = d.get("refresh_strategy", DEFAULT_REFRESH_STRATEGY)
    d["refreshInterval"] = d.get("refresh_interval", DEFAULT_REFRESH_INTERVAL)
    d["contentTone"] = d.get("content_tone", DEFAULT_CONTENT_TONE)
    d["mode_language"] = d.get("mode_language", "")
    d["modeLanguage"] = d["mode_language"]
    d["characterTones"] = d.get("character_tones", [])
    d["llmProvider"] = d.get("llm_provider", DEFAULT_LLM_PROVIDER)
    d["llmModel"] = d.get("llm_model", DEFAULT_LLM_MODEL)
    d["imageProvider"] = d.get("image_provider", DEFAULT_IMAGE_PROVIDER)
    d["imageModel"] = d.get("image_model", DEFAULT_IMAGE_MODEL)
    d["memoText"] = d.get("memo_text", "")
    # Parse JSON list fields from DB TEXT columns and normalize to arrays.
    # This avoids leaking raw JSON strings (for example "[]") to web clients.
    ce_raw = d.get("countdown_events", "[]")
    try:
        ce = json.loads(ce_raw) if isinstance(ce_raw, str) else ce_raw
    except (json.JSONDecodeError, TypeError):
        ce = []
    if not isinstance(ce, list):
        ce = []
    d["countdown_events"] = ce
    d["countdownEvents"] = ce

    tsr_raw = d.get("time_slot_rules", "[]")
    try:
        tsr = json.loads(tsr_raw) if isinstance(tsr_raw, str) else tsr_raw
    except (json.JSONDecodeError, TypeError):
        tsr = []
    if not isinstance(tsr, list):
        tsr = []
    d["time_slot_rules"] = tsr
    mo_raw = d.get("mode_overrides", "{}")
    try:
        mo = json.loads(mo_raw) if isinstance(mo_raw, str) else mo_raw
    except (json.JSONDecodeError, TypeError):
        mo = {}
    if not isinstance(mo, dict):
        mo = {}
    d["mode_overrides"] = mo
    d["modeOverrides"] = mo
    d["focus_listening"] = int(d.get("focus_listening", 0) or 0)
    d["is_focus_listening"] = bool(d["focus_listening"])
    d["always_active"] = int(d.get("always_active", 0) or 0)
    d["is_always_active"] = bool(d["always_active"])
    # Add mac field for cycle index tracking
    if "mac" not in d:
        d["mac"] = d.get("mac", "default")
    d["memo_text"] = d.get("memo_text", "")
    # 设备配置中不再存储 API key，相关标记统一为 False
    d["has_api_key"] = False
    d["has_image_api_key"] = False
    return d


async def get_active_config(mac: str, log_load: bool = True) -> Optional[dict]:
    db = await get_main_db()
    db.row_factory = None
    cursor = await db.execute(
        "SELECT * FROM configs WHERE mac = ? AND is_active = 1 ORDER BY id DESC LIMIT 1",
        (mac,),
    )
    row = await cursor.fetchone()
    if not row:
        return None
    columns = [desc[0] for desc in cursor.description]
    config = _row_to_dict(row, columns)
    if log_load:
        logger.info(
            f"[CONFIG LOAD] mac={mac}, id={config.get('id')}, refresh_strategy={config.get('refresh_strategy')}, modes={config.get('modes')}"
        )
    if config.get("llm_provider"):
        config["llm_provider"] = ""
    if config.get("llm_model"):
        config["llm_model"] = ""
    if config.get("image_provider"):
        config["image_provider"] = ""
    if config.get("image_model"):
        config["image_model"] = ""
    return config


async def get_config_history(mac: str) -> list[dict]:
    db = await get_main_db()
    db.row_factory = None
    cursor = await db.execute(
        "SELECT * FROM configs WHERE mac = ? ORDER BY created_at DESC",
        (mac,),
    )
    rows = await cursor.fetchall()
    if not rows:
        return []
    columns = [desc[0] for desc in cursor.description]
    return [_row_to_dict(r, columns) for r in rows]


async def activate_config(mac: str, config_id: int) -> bool:
    db = await get_main_db()
    cursor = await db.execute(
        "SELECT id FROM configs WHERE id = ? AND mac = ?", (config_id, mac)
    )
    if not await cursor.fetchone():
        return False
    await db.execute("UPDATE configs SET is_active = 0 WHERE mac = ?", (mac,))
    await db.execute("UPDATE configs SET is_active = 1 WHERE id = ?", (config_id,))
    await db.commit()
    return True


async def remove_mode_from_all_configs(mode_id: str, mac: Optional[str] = None) -> int:
    normalized_mode_id = str(mode_id or "").strip().upper()
    if not normalized_mode_id:
        return 0
    db = await get_main_db()
    if mac:
        cursor = await db.execute(
            """
            SELECT id, modes, mode_overrides
            FROM configs
            WHERE mac = ? AND (modes LIKE ? OR mode_overrides LIKE ?)
            """,
            (mac.upper(), f"%{normalized_mode_id}%", f"%{normalized_mode_id}%"),
        )
    else:
        cursor = await db.execute(
            "SELECT id, modes, mode_overrides FROM configs WHERE modes LIKE ? OR mode_overrides LIKE ?",
            (f"%{normalized_mode_id}%", f"%{normalized_mode_id}%"),
        )
    rows = await cursor.fetchall()
    updated = 0
    for config_id, modes_raw, overrides_raw in rows:
        modes = [
            m.strip().upper()
            for m in str(modes_raw or "").split(",")
            if m.strip() and m.strip().upper() != normalized_mode_id
        ]
        if not modes:
            modes = list(DEFAULT_MODES)

        try:
            overrides = json.loads(overrides_raw) if isinstance(overrides_raw, str) else overrides_raw
        except (json.JSONDecodeError, TypeError):
            overrides = {}
        if not isinstance(overrides, dict):
            overrides = {}
        cleaned_overrides = {
            str(key).strip().upper(): value
            for key, value in overrides.items()
            if str(key).strip().upper() != normalized_mode_id
        }

        await db.execute(
            "UPDATE configs SET modes = ?, mode_overrides = ? WHERE id = ?",
            (
                ",".join(modes),
                json.dumps(cleaned_overrides, ensure_ascii=False),
                config_id,
            ),
        )
        updated += 1
    if updated:
        await db.commit()
    return updated


async def get_cycle_index(mac: str) -> int:
    db = await get_main_db()
    cursor = await db.execute(
        "SELECT cycle_index FROM device_state WHERE mac = ?", (mac,)
    )
    row = await cursor.fetchone()
    return row[0] if row else 0


async def set_cycle_index(mac: str, idx: int):
    now = datetime.now().isoformat()
    db = await get_main_db()
    await db.execute(
        """INSERT INTO device_state (mac, cycle_index, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(mac) DO UPDATE SET cycle_index = ?, updated_at = ?""",
        (mac, idx, now, idx, now),
    )
    await db.commit()


async def get_photo_frame_index(mac: str) -> int:
    db = await get_main_db()
    cursor = await db.execute(
        "SELECT photo_frame_index FROM device_state WHERE mac = ?", (mac,)
    )
    row = await cursor.fetchone()
    return row[0] if row and row[0] else 0


async def set_photo_frame_index(mac: str, idx: int):
    now = datetime.now().isoformat()
    db = await get_main_db()
    await db.execute(
        """INSERT INTO device_state (mac, photo_frame_index, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(mac) DO UPDATE SET photo_frame_index = ?, updated_at = ?""",
        (mac, idx, now, idx, now),
    )
    await db.commit()


async def update_device_state(mac: str, **kwargs):
    """Update device state fields (last_persona, last_refresh_at, pending_refresh, etc.)."""
    now = datetime.now().isoformat()
    db = await get_main_db()
    # Ensure row exists
    await db.execute(
        """INSERT INTO device_state (mac, updated_at)
           VALUES (?, ?)
           ON CONFLICT(mac) DO UPDATE SET updated_at = ?""",
        (mac, now, now),
    )
    for key, value in kwargs.items():
        if key in (
            "last_persona",
            "last_refresh_at",
            "pending_refresh",
            "cycle_index",
            "photo_frame_index",
            "pending_mode",
            "last_state_poll_at",
            "runtime_mode",
            "expected_refresh_min",
            "            last_reconnect_regen_at",
            # OTA fields
            "pending_ota",
            "ota_version",
            "ota_url",
            "ota_original_url",
            "ota_progress",
            "ota_result",
            # chip_family
            "chip_family",
        ):
            await db.execute(
                f"UPDATE device_state SET {key} = ? WHERE mac = ?",
                (value, mac),
            )
    await db.commit()


async def get_device_state(mac: str) -> Optional[dict]:
    db = await get_main_db()
    db.row_factory = None
    cursor = await db.execute(
        "SELECT * FROM device_state WHERE mac = ?", (mac,)
    )
    row = await cursor.fetchone()
    if not row:
        return None
    columns = [desc[0] for desc in cursor.description]
    return dict(zip(columns, row))


async def set_pending_refresh(mac: str, pending: bool = True):
    now = datetime.now().isoformat()
    db = await get_main_db()
    await db.execute(
        """INSERT INTO device_state (mac, pending_refresh, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(mac) DO UPDATE SET pending_refresh = ?, updated_at = ?""",
        (mac, int(pending), now, int(pending), now),
    )
    await db.commit()


async def consume_pending_refresh(mac: str) -> bool:
    """Check and clear pending refresh flag. Returns True if was pending."""
    db = await get_main_db()
    cursor = await db.execute(
        "SELECT pending_refresh FROM device_state WHERE mac = ?", (mac,)
    )
    row = await cursor.fetchone()
    if row and row[0]:
        await db.execute(
            "UPDATE device_state SET pending_refresh = 0 WHERE mac = ?", (mac,)
        )
        await db.commit()
        return True
    return False


async def generate_device_token(mac: str) -> str:
    """Generate and store a new auth token for a device."""
    token = secrets.token_urlsafe(32)
    now = datetime.now().isoformat()
    db = await get_main_db()
    cursor = await db.execute(
        """UPDATE device_state SET auth_token = ?, updated_at = ? WHERE mac = ?""",
        (token, now, mac),
    )
    if cursor.rowcount == 0:
        await db.execute(
            """INSERT INTO device_state (mac, auth_token, updated_at) VALUES (?, ?, ?)""",
            (mac, token, now),
        )
    await db.commit()
    return token


async def validate_device_token(mac: str, token: str) -> bool:
    """Validate a device's auth token."""
    if not token:
        return False
    db = await get_main_db()
    cursor = await db.execute(
        "SELECT auth_token FROM device_state WHERE mac = ?", (mac,)
    )
    row = await cursor.fetchone()
    if not row or not row[0]:
        return False
    return row[0] == token


async def get_user_custom_modes(user_id: int, mac: Optional[str] = None) -> list[dict]:
    """Get all custom modes for a specific user, optionally filtered by device MAC."""
    db = await get_main_db()
    if mac:
        cursor = await db.execute(
            """
            SELECT mode_id, mac, definition_json, created_at, updated_at
            FROM local_custom_modes
            WHERE mac = ? OR mac = ''
            ORDER BY CASE WHEN mac = '' THEN 0 ELSE 1 END, created_at DESC
            """,
            (mac.upper(),),
        )
    else:
        cursor = await db.execute(
            """
            SELECT mode_id, mac, definition_json, created_at, updated_at
            FROM local_custom_modes
            
            ORDER BY created_at DESC
            """,
            (),
        )
    rows = await cursor.fetchall()
    modes = []
    for row in rows:
        try:
            definition = json.loads(row[2])
            modes.append({
                "mode_id": row[0],
                "mac": row[1],
                "definition": definition,
                "created_at": row[3],
                "updated_at": row[4],
            })
        except json.JSONDecodeError:
            logger.error(f"[CUSTOM_MODES] Failed to parse definition for mode {row[0]}")
    return modes


async def get_custom_mode(user_id: int, mode_id: str, mac: Optional[str] = None) -> Optional[dict]:
    """
    Get a specific custom mode for a user *and* device.

    重要：为了保证设备隔离，这里必须同时按 user_id 和 mac 过滤；
    如果调用方没有提供 mac，则直接返回 None，而不是在所有设备中“拍脑袋选一条”。
    """
    if not mac:
        logger.warning(
            "[CUSTOM_MODES] get_custom_mode called without mac (user_id=%s, mode_id=%s) – returning None to preserve device isolation",
            user_id,
            mode_id,
        )
        return None

    db = await get_main_db()
    cursor = await db.execute(
        """
        SELECT mac, definition_json, created_at, updated_at
        FROM local_custom_modes
        WHERE mode_id = ? AND mac = ?
        """,
        (mode_id.upper(), mac.upper()),
    )
    row = await cursor.fetchone()
    if not row:
        return None
    try:
        definition = json.loads(row[1])
        return {
            "mode_id": mode_id.upper(),
            "mac": row[0],
            "definition": definition,
            "created_at": row[2],
            "updated_at": row[3],
        }
    except json.JSONDecodeError:
        logger.error(f"[CUSTOM_MODES] Failed to parse definition for mode {mode_id}")
        return None


async def save_custom_mode(user_id: int, mode_id: str, definition: dict, mac: str) -> bool:
    """Save or update a custom mode for a user and device."""
    db = await get_main_db()
    mode_id = mode_id.upper()
    mac = mac.upper()
    now = datetime.now().isoformat()
    definition_json = json.dumps(definition, ensure_ascii=False)
    
    try:
        await db.execute(
            """
            INSERT INTO local_custom_modes (mode_id, mac, definition_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(mode_id, mac) DO UPDATE SET
                definition_json = ?,
                updated_at = ?
            """,
            (mode_id, mac, definition_json, now, now, definition_json, now),
        )
        await db.commit()
        logger.info(f"[CUSTOM_MODES] Saved custom mode {mode_id} for user {user_id} on device {mac}")
        return True
    except Exception as e:
        logger.error(f"[CUSTOM_MODES] Failed to save custom mode {mode_id} for user {user_id} on device {mac}: {e}")
        await db.rollback()
        return False


async def delete_custom_mode(user_id: int, mode_id: str, mac: Optional[str] = None) -> bool:
    """
    Delete a custom mode for a specific user and device.

    重要：不再支持“只按 user_id + mode_id 删除所有设备上的记录”，
    避免在一台设备上删除时把同一用户其他设备上的同名模式也一并删掉。
    调用方必须提供 mac，否则这里会直接返回 False。
    """
    if not mac:
        logger.warning(
            "[CUSTOM_MODES] delete_custom_mode called without mac (user_id=%s, mode_id=%s) – refusing to delete to preserve device isolation",
            user_id,
            mode_id,
        )
        return False

    db = await get_main_db()
    mode_id = mode_id.upper()
    try:
        cursor = await db.execute(
            """
            DELETE FROM local_custom_modes
            WHERE mode_id = ? AND mac = ?
            """,
            (mode_id, mac.upper()),
        )
        await db.commit()
        deleted = cursor.rowcount > 0
        if deleted:
            logger.info(
                "[CUSTOM_MODES] Deleted custom mode %s for user %s on device %s",
                mode_id,
                user_id,
                mac,
            )
        return deleted
    except Exception as e:
        logger.error(
            "[CUSTOM_MODES] Failed to delete custom mode %s for user %s on device %s: %s",
            mode_id,
            user_id,
            mac,
            e,
        )
        await db.rollback()
        return False
