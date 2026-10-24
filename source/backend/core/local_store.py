"""Local-instance storage. Legacy tables are migrated once and left untouched."""
from __future__ import annotations

import json
import os
from datetime import datetime
from typing import Optional

from .crypto import decrypt_api_key, encrypt_api_key
from .db import get_main_db

LOCAL_INSTANCE_ID = 1
LLM_DEFAULTS = {
    "llm_access_mode": "preset", "provider": "deepseek", "model": "",
    "api_key": "", "base_url": "", "image_provider": "aliyun",
    "image_model": "", "image_api_key": "", "image_base_url": "",
}
LLM_FIELDS = tuple(LLM_DEFAULTS)
LEGACY_TABLES = frozenset({"device_memberships", "user_devices", "user_llm_config", "user_preferences", "custom_modes", "shared_modes"})


async def _rows(db, table: str) -> list[dict]:
    # Fixed migration table names only; no request-controlled SQL identifiers.
    if table not in LEGACY_TABLES:
        raise ValueError("Unsupported legacy table")
    cursor = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,))
    if not await cursor.fetchone():
        return []
    cursor = await db.execute(f"SELECT * FROM {table}")
    names = [column[0] for column in cursor.description]
    return [dict(zip(names, row)) for row in await cursor.fetchall()]


async def init_local_store(db) -> None:
    await db.executescript("""
        CREATE TABLE IF NOT EXISTS local_instance (
            id INTEGER PRIMARY KEY CHECK(id=1), migrated_at TEXT NOT NULL,
            source_user_id INTEGER, edition TEXT NOT NULL DEFAULT 'local'
        );
        CREATE TABLE IF NOT EXISTS local_devices (
            mac TEXT PRIMARY KEY, nickname TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS local_llm_config (
            id INTEGER PRIMARY KEY CHECK(id=1),
            llm_access_mode TEXT DEFAULT 'preset', provider TEXT DEFAULT 'deepseek',
            model TEXT DEFAULT '', api_key TEXT DEFAULT '', base_url TEXT DEFAULT '',
            image_provider TEXT DEFAULT 'aliyun', image_model TEXT DEFAULT '',
            image_api_key TEXT DEFAULT '', image_base_url TEXT DEFAULT '', updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS local_preferences (
            id INTEGER PRIMARY KEY CHECK(id=1), locale TEXT DEFAULT 'zh',
            timezone TEXT DEFAULT 'Asia/Shanghai', widget_mode TEXT DEFAULT 'STOIC',
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS local_custom_modes (
            id INTEGER PRIMARY KEY AUTOINCREMENT, mode_id TEXT NOT NULL,
            mac TEXT NOT NULL, definition_json TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(mode_id, mac)
        );
        CREATE TABLE IF NOT EXISTS local_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT, mode_id TEXT NOT NULL,
            name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'custom',
            definition_json TEXT NOT NULL, source_ref TEXT UNIQUE,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
    """)
    cursor = await db.execute("SELECT id FROM local_instance WHERE id=1")
    if await cursor.fetchone():
        return
    memberships = await _rows(db, "device_memberships")
    legacy_devices = await _rows(db, "user_devices")
    llm_rows = await _rows(db, "user_llm_config")
    raw_owner = os.getenv("INKSIGHT_LOCAL_USER_ID", "").strip()
    if raw_owner:
        owner_id = int(raw_owner)
        if owner_id <= 0:
            raise ValueError("INKSIGHT_LOCAL_USER_ID must be positive during migration")
    else:
        owners = sorted({int(r["user_id"]) for r in memberships if r.get("role") == "owner" and r.get("status") == "active"})
        owners = owners or sorted({int(r["user_id"]) for r in legacy_devices})
        owners = owners or sorted({int(r["user_id"]) for r in llm_rows})
        if len(owners) > 1:
            raise ValueError("Select INKSIGHT_LOCAL_USER_ID once to migrate this multi-account installation")
        owner_id = owners[0] if owners else None
    now = datetime.now().isoformat()
    active = [r for r in memberships if r.get("user_id") == owner_id and r.get("status") == "active"]
    if not memberships:
        active = [r for r in legacy_devices if r.get("user_id") == owner_id]
    for row in active:
        mac = str(row.get("mac") or "").upper()
        if mac:
            await db.execute("INSERT OR IGNORE INTO local_devices VALUES (?, ?, ?, ?)",
                             (mac, row.get("nickname") or "", row.get("created_at") or row.get("bound_at") or now, row.get("updated_at") or now))
    for row in llm_rows:
        if row.get("user_id") == owner_id:
            # Copy ciphertext verbatim. The deployment retains ENCRYPTION_KEY.
            values = [row.get(field, LLM_DEFAULTS[field]) or LLM_DEFAULTS[field] for field in LLM_FIELDS]
            await db.execute(f"INSERT OR IGNORE INTO local_llm_config (id,{','.join(LLM_FIELDS)},updated_at) VALUES (1,{','.join('?' for _ in LLM_FIELDS)},?)", (*values, row.get("updated_at") or now))
    for row in await _rows(db, "user_preferences"):
        if row.get("user_id") == owner_id:
            await db.execute("INSERT OR IGNORE INTO local_preferences VALUES (1,?,?,?,?)", (row.get("locale") or "zh", row.get("timezone") or "Asia/Shanghai", row.get("widget_mode") or "STOIC", row.get("updated_at") or now))
    for row in await _rows(db, "custom_modes"):
        if row.get("user_id") != owner_id:
            continue
        mac = str(row.get("mac") or "").upper()
        if mac:
            await db.execute("INSERT OR IGNORE INTO local_custom_modes (mode_id,mac,definition_json,created_at,updated_at) VALUES (?,?,?,?,?)", (row["mode_id"], mac, row["definition_json"], row.get("created_at") or now, row.get("updated_at") or now))
        else:
            await db.execute("INSERT OR IGNORE INTO local_custom_modes (mode_id,mac,definition_json,created_at,updated_at) VALUES (?,'',?,?,?)", (row["mode_id"], row["definition_json"], row.get("created_at") or now, row.get("updated_at") or now))
            await _import_template(db, json.loads(row["definition_json"]), f"legacy-custom:{row['id']}", now)
    for row in await _rows(db, "shared_modes"):
        # Shared templates are instance data; retain archived entries too.
        await _import_template(db, json.loads(row["config_json"]), f"legacy-shared:{row['id']}", now, metadata=row)
    await db.execute("INSERT INTO local_instance (id,migrated_at,source_user_id) VALUES (1,?,?)", (now, owner_id))
    await db.commit()


async def get_local_device(mac: str) -> Optional[dict]:
    db = await get_main_db()
    cursor = await db.execute("SELECT mac,nickname,created_at,updated_at FROM local_devices WHERE mac=?", (mac.upper(),))
    row = await cursor.fetchone()
    if not row:
        return None
    return {"mac": row[0], "nickname": row[1], "created_at": row[2], "updated_at": row[3],
            "bound_at": row[2], "role": "owner", "status": "active", "user_id": LOCAL_INSTANCE_ID, "username": "local"}


async def list_local_devices() -> list[dict]:
    db = await get_main_db()
    cursor = await db.execute("""SELECT d.mac,d.nickname,d.created_at,
        COALESCE(NULLIF(s.last_state_poll_at,''),NULLIF(s.last_refresh_at,''),'')
        FROM local_devices d LEFT JOIN device_state s ON UPPER(s.mac)=d.mac ORDER BY d.created_at DESC""")
    return [{"mac": r[0], "nickname": r[1], "bound_at": r[2], "role": "owner", "status": "active", "last_seen": r[3]} for r in await cursor.fetchall()]


async def add_local_device(mac: str, nickname: str = "") -> dict:
    db = await get_main_db()
    now = datetime.now().isoformat()
    await db.execute("""INSERT INTO local_devices VALUES (?,?,?,?) ON CONFLICT(mac) DO UPDATE SET
        nickname=CASE WHEN excluded.nickname!='' THEN excluded.nickname ELSE local_devices.nickname END,
        updated_at=excluded.updated_at""", (mac.upper(), nickname, now, now))
    await db.commit()
    return {"status": "claimed", "role": "owner", "device": await get_local_device(mac)}


async def rename_local_device(mac: str, nickname: str) -> bool:
    db = await get_main_db()
    cursor = await db.execute("UPDATE local_devices SET nickname=?,updated_at=? WHERE mac=?", (nickname, datetime.now().isoformat(), mac.upper()))
    await db.commit()
    return cursor.rowcount > 0


async def remove_local_device(mac: str) -> bool:
    db = await get_main_db()
    cursor = await db.execute("DELETE FROM local_devices WHERE mac=?", (mac.upper(),))
    await db.commit()
    return cursor.rowcount > 0


async def get_local_llm_config(*, encrypted: bool = False) -> Optional[dict]:
    db = await get_main_db()
    cursor = await db.execute(f"SELECT {','.join(LLM_FIELDS)} FROM local_llm_config WHERE id=1")
    row = await cursor.fetchone()
    if not row:
        return None
    result = dict(zip(LLM_FIELDS, row))
    if not encrypted:
        for field in ("api_key", "image_api_key"):
            result[field] = decrypt_api_key(result.get(field) or "")
    return result


async def save_local_llm_config(data: dict) -> bool:
    previous = await get_local_llm_config(encrypted=True) or LLM_DEFAULTS.copy()
    merged = previous.copy()
    for field in LLM_FIELDS:
        if field not in data:
            continue
        value = str(data[field] or "").strip()
        if field in ("api_key", "image_api_key"):
            if not value or "****" in value or "••••" in value:
                continue
            value = encrypt_api_key(value)
        merged[field] = value
    db = await get_main_db()
    await db.execute(f"""INSERT INTO local_llm_config (id,{','.join(LLM_FIELDS)},updated_at)
        VALUES (1,{','.join('?' for _ in LLM_FIELDS)},?) ON CONFLICT(id) DO UPDATE SET
        {','.join(f'{f}=excluded.{f}' for f in LLM_FIELDS)},updated_at=excluded.updated_at""",
        (*[merged[f] for f in LLM_FIELDS], datetime.now().isoformat()))
    await db.commit()
    return True


async def delete_local_llm_config() -> bool:
    db = await get_main_db()
    cursor = await db.execute("DELETE FROM local_llm_config WHERE id=1")
    await db.commit()
    return cursor.rowcount > 0


async def get_local_preferences() -> dict:
    db = await get_main_db()
    cursor = await db.execute("SELECT locale,timezone,widget_mode,updated_at FROM local_preferences WHERE id=1")
    row = await cursor.fetchone()
    return dict(zip(("locale", "timezone", "widget_mode", "updated_at"), row)) if row else {"locale": "zh", "timezone": "Asia/Shanghai", "widget_mode": "STOIC", "updated_at": ""}


async def save_local_preferences(data: dict) -> dict:
    current = await get_local_preferences()
    for key in ("locale", "timezone", "widget_mode"):
        if key in data and str(data[key] or "").strip():
            current[key] = str(data[key]).strip()
    db = await get_main_db()
    await db.execute("""INSERT INTO local_preferences VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        locale=excluded.locale,timezone=excluded.timezone,widget_mode=excluded.widget_mode,updated_at=excluded.updated_at""",
        (current["locale"], current["timezone"], current["widget_mode"], datetime.now().isoformat()))
    await db.commit()
    return await get_local_preferences()


async def _import_template(db, definition: dict, source_ref: Optional[str], now: str, *, metadata: Optional[dict] = None) -> int:
    metadata = metadata or {}
    mode_id = str(definition.get("mode_id") or definition.get("id") or "CUSTOM").upper()
    name = str(metadata.get("name") or definition.get("display_name") or definition.get("name") or mode_id)
    description = str(metadata.get("description") if metadata.get("description") is not None else definition.get("description") or "")
    category = str(metadata.get("category") or definition.get("category") or "custom")
    cursor = await db.execute("""INSERT OR IGNORE INTO local_templates
        (mode_id,name,description,category,definition_json,source_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)""",
        (mode_id, name, description, category, json.dumps(definition, ensure_ascii=False), source_ref, metadata.get("created_at") or now, now))
    return cursor.lastrowid


async def import_local_template(definition: dict, metadata: Optional[dict] = None) -> int:
    db = await get_main_db()
    result = await _import_template(db, definition, None, datetime.now().isoformat(), metadata=metadata)
    await db.commit()
    return result


async def list_local_templates() -> list[dict]:
    db = await get_main_db()
    cursor = await db.execute("SELECT id,mode_id,name,description,category,definition_json,created_at,updated_at FROM local_templates ORDER BY updated_at DESC,id DESC")
    return [{"id": r[0], "mode_id": r[1], "name": r[2], "description": r[3], "category": r[4], "definition": json.loads(r[5]), "created_at": r[6], "updated_at": r[7]} for r in await cursor.fetchall()]


async def delete_local_template(template_id: int) -> bool:
    db = await get_main_db()
    cursor = await db.execute("DELETE FROM local_templates WHERE id=?", (template_id,))
    await db.commit()
    return cursor.rowcount > 0


async def get_global_custom_mode(mode_id: str) -> Optional[dict]:
    db = await get_main_db()
    cursor = await db.execute("SELECT definition_json FROM local_custom_modes WHERE mac='' AND mode_id=?", (mode_id.upper(),))
    row = await cursor.fetchone()
    return json.loads(row[0]) if row else None


async def save_global_custom_mode(mode_id: str, definition: dict) -> None:
    db = await get_main_db()
    now = datetime.now().isoformat()
    await db.execute("""INSERT INTO local_custom_modes (mode_id,mac,definition_json,created_at,updated_at)
        VALUES (?,'',?,?,?) ON CONFLICT(mode_id,mac) DO UPDATE SET
        definition_json=excluded.definition_json,updated_at=excluded.updated_at""",
        (mode_id.upper(), json.dumps(definition, ensure_ascii=False), now, now))
    await db.commit()


async def delete_global_custom_mode(mode_id: str) -> bool:
    db = await get_main_db()
    cursor = await db.execute("DELETE FROM local_custom_modes WHERE mac='' AND mode_id=?", (mode_id.upper(),))
    await db.commit()
    return cursor.rowcount > 0


async def load_global_custom_modes() -> None:
    from .mode_registry import get_registry
    db = await get_main_db()
    cursor = await db.execute("SELECT mode_id,definition_json FROM local_custom_modes WHERE mac=''")
    registry = get_registry()
    for mode_id, definition in await cursor.fetchall():
        registry.load_custom_mode_from_dict(mode_id, json.loads(definition), source="custom")


async def apply_local_ai_settings(config: Optional[dict]) -> dict:
    """Also used by cache warmups, widgets and background renders."""
    result = dict(config or {})
    settings = await get_local_llm_config()
    if not settings:
        return result
    fields = {
        "llm_access_mode": "llm_access_mode", "provider": "llm_provider",
        "model": "llm_model", "api_key": "user_api_key", "image_provider": "image_provider",
        "image_model": "image_model", "image_api_key": "user_image_api_key", "image_base_url": "image_base_url",
    }
    for source, target in fields.items():
        if settings.get(source) and not (target in {"user_api_key", "user_image_api_key"} and result.get(target)):
            result[target] = settings[source]
    if settings.get("llm_access_mode") == "custom_openai" and settings.get("base_url"):
        result["llm_base_url"] = settings["base_url"]
    return result
