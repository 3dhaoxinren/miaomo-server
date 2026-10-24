"""Local-edition upgrade, client-contract and browser-boundary regression tests."""
from __future__ import annotations

import io
import json
import os
import sqlite3
from unittest.mock import AsyncMock

import httpx
import pytest
from PIL import Image

from core import config_store, db, local_store
from core.crypto import decrypt_api_key, encrypt_api_key

MAC = "AA:BB:CC:DD:EE:01"
OTHER_MAC = "AA:BB:CC:DD:EE:02"


@pytest.fixture
async def isolated(tmp_path, monkeypatch):
    await db.close_all()
    path = str(tmp_path / "local.db")
    cache = str(tmp_path / "cache.db")
    monkeypatch.setattr(db, "_MAIN_DB_PATH", path)
    monkeypatch.setattr(db, "_CACHE_DB_PATH", cache)
    monkeypatch.setattr(config_store, "DB_PATH", path)
    monkeypatch.setattr("core.stats_store.DB_PATH", path)
    monkeypatch.setattr("core.cache._CACHE_DB_PATH", cache)
    monkeypatch.setattr("core.vocab_store.seed_builtin_vocab", AsyncMock())
    monkeypatch.delenv("INKSIGHT_LOCAL_USER_ID", raising=False)
    monkeypatch.delenv("INKSIGHT_UPLOADS_MAX_AGE_DAYS", raising=False)
    monkeypatch.delenv("INKSIGHT_UPLOADS_MAX_TOTAL_MB", raising=False)
    monkeypatch.setenv("ENCRYPTION_KEY", "isolated-fixture-key")
    yield path
    await db.close_all()


@pytest.fixture
async def client(isolated, tmp_path, monkeypatch):
    from api.index import app
    from core.cache import init_cache_db, content_cache
    from core.stats_store import init_stats_db
    from core.static_store import init_static_tables, migrate_device_state_columns
    from core.mode_registry import reset_registry
    from api.routes import uploads
    monkeypatch.setattr(uploads, "_UPLOAD_DIR", tmp_path / "uploads")
    await config_store.init_db()
    await init_stats_db()
    await init_cache_db()
    await init_static_tables()
    await migrate_device_state_columns()
    reset_registry()
    content_cache._cache.clear()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as value:
        yield value
    content_cache._cache.clear()


@pytest.mark.asyncio
async def test_fresh_instance_needs_no_account_or_owner_environment(isolated):
    await config_store.init_db()
    await config_store.init_db()
    with sqlite3.connect(isolated) as conn:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"local_devices", "local_llm_config", "local_custom_modes", "local_instance"} <= tables
    assert not {"users", "api_quotas", "invitation_codes", "device_memberships", "push_tokens", "user_activity_events"} & tables
    from core.auth import get_local_user
    assert (await get_local_user())["edition"] == "local"
    assert await local_store.list_local_devices() == []


@pytest.mark.asyncio
async def test_upgrade_preserves_owner_data_ciphertext_and_is_repeatable(isolated, monkeypatch):
    await config_store.init_db()
    await db.close_all()
    key = encrypt_api_key("sk-migrated-private")
    definition = {"mode_id": "MY_TEST", "display_name": "测试", "content": {"type": "static", "text": "ok"}}
    with sqlite3.connect(isolated) as conn:
        # Recreate an old account installation around real operational tables.
        conn.execute("DELETE FROM local_instance")
        conn.executescript("""
            CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT);
            CREATE TABLE device_memberships (mac TEXT,user_id INTEGER,role TEXT,status TEXT,nickname TEXT,created_at TEXT,updated_at TEXT);
            CREATE TABLE user_llm_config (user_id INTEGER PRIMARY KEY,llm_access_mode TEXT,provider TEXT,model TEXT,api_key TEXT,base_url TEXT,image_provider TEXT,image_model TEXT,image_api_key TEXT,image_base_url TEXT,updated_at TEXT);
            CREATE TABLE custom_modes (id INTEGER PRIMARY KEY,mode_id TEXT,user_id INTEGER,mac TEXT,definition_json TEXT,created_at TEXT,updated_at TEXT);
            CREATE TABLE shared_modes (id INTEGER PRIMARY KEY,config_json TEXT,name TEXT,description TEXT,category TEXT);
        """)
        conn.execute("INSERT INTO users VALUES (7,'original','untouched')")
        conn.execute("INSERT INTO device_memberships VALUES (?,7,'owner','active','客厅','old','old')", (MAC,))
        conn.execute("INSERT INTO device_memberships VALUES (?,9,'owner','active','其它','old','old')", (OTHER_MAC,))
        conn.execute("INSERT INTO user_llm_config VALUES (7,'custom_openai','openai_compat','old-model',?,'http://ai.local/v1','aliyun','image-model',?,'http://image.local/v1','old')", (key, key))
        conn.execute("INSERT INTO device_state (mac,auth_token,updated_at) VALUES (?,'existing-device-secret','old')", (MAC,))
        conn.execute("INSERT INTO device_state (mac,auth_token,updated_at) VALUES (?,'unowned-secret','old')", (OTHER_MAC,))
        conn.execute("INSERT INTO configs (mac,modes,mode_overrides,created_at) VALUES (?,'MY_ADAPTIVE',?,'old')", (MAC, json.dumps({"MY_ADAPTIVE": {"image_urls": ["/api/uploads/existing-photo"]}})))
        conn.execute("INSERT INTO custom_modes VALUES (1,'MY_TEST',7,?,?, 'old','old')", (MAC, json.dumps(definition)))
        conn.execute("INSERT INTO shared_modes VALUES (1,?,'出版名称','独立描述','life')", (json.dumps(definition),))
        before = {t: conn.execute(f"SELECT * FROM {t}").fetchall() for t in ("users", "device_memberships", "user_llm_config", "configs", "device_state", "custom_modes", "shared_modes")}
    monkeypatch.setenv("INKSIGHT_LOCAL_USER_ID", "7")
    await config_store.init_db()
    assert [d["mac"] for d in await local_store.list_local_devices()] == [MAC]
    assert (await config_store.get_custom_mode(1, "MY_TEST", MAC))["definition"] == definition
    assert len(await local_store.list_local_templates()) == 1
    template = (await local_store.list_local_templates())[0]
    assert (template["name"], template["description"], template["category"]) == ("出版名称", "独立描述", "life")
    assert (await local_store.get_local_llm_config())["api_key"] == "sk-migrated-private"
    assert (await local_store.get_local_llm_config(encrypted=True))["api_key"] == key
    await local_store.rename_local_device(MAC, "新名称")
    await local_store.save_local_llm_config({"model": "new-model"})
    await config_store.init_db()
    assert (await local_store.get_local_device(MAC))["nickname"] == "新名称"
    assert (await local_store.get_local_llm_config())["model"] == "new-model"
    assert len(await local_store.list_local_templates()) == 1
    with sqlite3.connect(isolated) as conn:
        for table, rows in before.items():
            assert conn.execute(f"SELECT * FROM {table}").fetchall() == rows, table


@pytest.mark.asyncio
async def test_secret_partial_update_masking_and_explicit_delete(client):
    response = await client.put("/api/local/settings/llm", json={"provider": "deepseek", "model": "chosen", "api_key": "sk-preserve", "image_api_key": "image-preserve"})
    assert response.status_code == 200
    original = await local_store.get_local_llm_config(encrypted=True)
    assert original["api_key"] != "sk-preserve"
    settings = (await client.get("/api/local/settings")).json()
    assert settings["llm_config"]["api_key"] == "****"
    await client.put("/api/user/profile/llm", json={"api_key": "", "image_api_key": "****", "model": "changed"})
    current = await local_store.get_local_llm_config(encrypted=True)
    assert current["api_key"] == original["api_key"]
    assert current["image_api_key"] == original["image_api_key"]
    assert decrypt_api_key(current["api_key"]) == "sk-preserve"
    assert (await client.delete("/api/user/profile/llm")).json()["deleted"] is True
    assert (await client.delete("/api/local/settings/llm")).json()["deleted"] is False


@pytest.mark.asyncio
async def test_obsolete_routes_are_actually_absent(client):
    from api.index import app
    removed = ["/auth/register", "/auth/login", "/auth/logout", "/auth/reset-password", "/user/redeem", "/user/bind-email", "/user/devices/requests", "/claim/consume", "/push/register", "/push/unregister"]
    paths = {route.path for route in app.routes}
    for path in removed:
        assert "/api" + path not in paths
    assert not any(any(word in path for word in ("/analytics", "/discover", "/members", "/claim-token")) for path in paths)
    for method, path in [("POST", "/auth/register"), ("POST", "/user/redeem"), ("POST", "/push/register")]:
        assert (await client.request(method, "/api" + path, json={})).status_code == 404
    response = await client.get("/api/auth/me", headers={"Cookie": "ink_session=expired.jwt"})
    assert response.json()["auth_mode"] == "local"
    assert "set-cookie" not in response.headers


@pytest.mark.asyncio
async def test_host_and_origin_checks_still_protect_local_console(client):
    assert (await client.get("/api/local/settings", headers={"Host": "attacker.example"})).status_code == 400
    assert (await client.get("/api/local/settings", headers={"Origin": "https://attacker.example"})).status_code == 403
    assert (await client.post("/api/local/devices", headers={"Origin": "https://www.inksight.site"}, json={"mac": MAC})).status_code == 403
    assert (await client.get("/api/local/settings", headers={"Origin": "http://test"})).status_code == 200


@pytest.mark.asyncio
async def test_device_config_photos_and_token_contracts(client):
    added = await client.post("/api/user/devices", json={"mac": MAC, "nickname": "客厅"})
    assert added.status_code == 200
    image = io.BytesIO()
    Image.new("RGB", (64, 48), "white").save(image, format="JPEG")
    uploaded = await client.post("/api/uploads", content=image.getvalue(), headers={"Content-Type": "application/octet-stream", "X-Upload-Content-Type": "image/jpeg"})
    assert uploaded.status_code == 200
    url = uploaded.json()["url"]
    data = {"mac": MAC, "modes": ["MY_ADAPTIVE", "CALENDAR"], "refreshStrategy": "cycle", "refreshInterval": 30,
            "modeOverrides": {"MY_ADAPTIVE": {"image_urls": [url], "image_url": url}, "CALENDAR": {"mode_settings": {"reminders": [{"date": "2026-10-24", "text": "测试"}]}}}}
    assert (await client.post("/api/config", json=data)).status_code == 200
    active = (await client.get(f"/api/config/{MAC}")).json()
    assert active["mode_overrides"] == data["modeOverrides"]
    assert (await client.get(url)).content == image.getvalue()
    token = (await client.post(f"/api/device/{MAC}/token")).json()["token"]
    assert (await client.get(f"/api/device/{MAC}/state", headers={"X-Device-Token": "wrong"})).status_code == 401
    assert (await client.get(f"/api/device/{MAC}/state", headers={"X-Device-Token": token})).status_code == 200
    assert (await client.get("/api/render", params={"mac": MAC}, headers={"X-Device-Token": "wrong"})).status_code == 401
    assert (await client.post(f"/api/device/{MAC}/refresh")).status_code == 200
    assert (await client.delete(f"/api/local/devices/{MAC}")).status_code == 200
    assert await config_store.get_active_config(MAC) is not None
    assert (await client.get(url)).content == image.getvalue()


@pytest.mark.asyncio
async def test_default_retention_never_deletes_existing_photos(client, tmp_path):
    from api.routes import uploads
    uploads._UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    original = uploads._UPLOAD_DIR / "legacy-original.bin"
    original.write_bytes(b"old photo without metadata")
    os.utime(original, (1, 1))
    uploads.cleanup_runtime_uploads(force=True)
    assert original.read_bytes() == b"old photo without metadata"


@pytest.mark.asyncio
async def test_all_builtin_modes_remain_available(client):
    payload = (await client.get("/api/modes/catalog")).json()
    items = payload["items"]
    builtin = [item for item in items if item.get("source") != "custom"]
    assert len(builtin) == 30
    ids = {item.get("id") or item.get("mode_id") for item in builtin}
    assert {"MY_ADAPTIVE", "CALENDAR", "WEATHER", "MEMO"} <= ids


@pytest.mark.asyncio
async def test_local_template_round_trip(client):
    from pathlib import Path
    from core.mode_registry import BUILTIN_JSON_DIR
    definition = json.loads(next(Path(BUILTIN_JSON_DIR).glob("*.json")).read_text(encoding="utf-8"))
    response = await client.post("/api/local/templates/import", json={"definition": definition, "name": "我的模板", "description": "模板说明", "category": "life"})
    assert response.status_code == 200, response.text
    template_id = response.json()["id"]
    exported = (await client.get(f"/api/local/templates/{template_id}/export")).json()
    assert exported["definition"] == definition
    assert (exported["name"], exported["description"], exported["category"]) == ("我的模板", "模板说明", "life")
    assert (await client.get("/api/local/templates")).json()["templates"][0]["id"] == template_id
    assert (await client.delete(f"/api/local/templates/{template_id}")).status_code == 200


@pytest.mark.asyncio
async def test_render_cache_and_fallback_work_without_any_quota_table(client, monkeypatch):
    from api import shared
    from core.mode_registry import get_registry
    await local_store.add_local_device(MAC)
    await config_store.save_config(MAC, {"modes": ["STOIC"], "refreshInterval": 30})
    monkeypatch.setenv("INKSIGHT_BILLING_ENABLED", "1")  # Obsolete env cannot reenable billing.
    image = Image.new("1", (400, 300), 1)
    monkeypatch.setattr(shared.content_cache, "check_and_regenerate_all", AsyncMock())
    monkeypatch.setattr(shared.content_cache, "get", AsyncMock(return_value=image))
    generator = AsyncMock(return_value=(image, {"_is_fallback": True}))
    monkeypatch.setattr(shared, "generate_and_render", generator)
    result = await shared.build_image(3.8, MAC, "STOIC", screen_w=400, screen_h=300)
    assert result[0] is image and result[2] is True and result[4] is False
    generator.assert_not_awaited()
    monkeypatch.setattr(shared, "get_date_context", AsyncMock(return_value={}))
    monkeypatch.setattr(shared, "get_weather", AsyncMock(return_value={}))
    monkeypatch.setattr(shared.content_cache, "set", AsyncMock())
    monkeypatch.setattr(shared, "save_render_content", AsyncMock())
    result = await shared.build_image(3.8, MAC, "STOIC", screen_w=400, screen_h=300, skip_cache=True)
    assert result[0] is image and result[3] is True and result[4] is False


@pytest.mark.asyncio
async def test_global_custom_mode_survives_registry_restart(client):
    from core.mode_registry import get_registry, reset_registry
    definition = {
        "mode_id": "LOCAL_NOTE", "display_name": "本地便签", "content": {"type": "static", "static_data": {"text": "hello"}},
        "layout": {"body": [{"type": "centered_text", "field": "text", "font_size": 18}]},
    }
    created = await client.post("/api/modes/custom", json=definition)
    assert created.status_code == 200, created.text
    reset_registry()
    await local_store.load_global_custom_modes()
    assert get_registry().get_json_mode("LOCAL_NOTE").definition == definition
    assert (await client.get("/api/modes/custom/LOCAL_NOTE")).json() == definition
    assert (await client.delete("/api/modes/custom/LOCAL_NOTE")).status_code == 200
    reset_registry()
    await local_store.load_global_custom_modes()
    assert get_registry().get_json_mode("LOCAL_NOTE") is None
    assert (await client.post("/api/local/templates/import", json={**definition, "mode_id": "../escape"})).status_code == 400


@pytest.mark.asyncio
async def test_reconnect_cache_warmup_uses_instance_ai_config(client, monkeypatch):
    from core.cache import ContentCache
    await local_store.save_local_llm_config({"llm_access_mode": "custom_openai", "provider": "openai_compat", "api_key": "local-secret", "base_url": "http://ai.local/v1", "model": "local-model"})
    cache = ContentCache()
    generator = AsyncMock()
    monkeypatch.setattr(cache, "_generate_all_modes", generator)
    assert await cache.force_regenerate_all(MAC, {"modes": ["STOIC"]}) is True
    sent_config = generator.await_args.args[1]
    assert sent_config["user_api_key"] == "local-secret"
    assert sent_config["llm_base_url"] == "http://ai.local/v1"
    assert sent_config["llm_model"] == "local-model"
