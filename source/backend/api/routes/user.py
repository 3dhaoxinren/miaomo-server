"""Local settings and device management, plus existing mobile-client aliases."""
from __future__ import annotations

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from fastapi import APIRouter, HTTPException
from core.auth import validate_mac_param
from core.local_store import (
    add_local_device, delete_local_llm_config, get_local_llm_config,
    get_local_preferences, list_local_devices, remove_local_device,
    rename_local_device, save_local_llm_config, save_local_preferences,
    list_local_templates, import_local_template, delete_local_template,
)
from core.mode_registry import _validate_mode_def_with_error

router = APIRouter(tags=["local"])


@router.get("/local/devices")
@router.get("/user/devices")
async def list_user_devices():
    return {"devices": await list_local_devices()}


@router.post("/local/devices")
@router.post("/user/devices")
async def bind_user_device(body: dict):
    mac = validate_mac_param(str(body.get("mac") or "").strip())
    nickname = str(body.get("nickname") or "").strip()[:100]
    return {"ok": True, **await add_local_device(mac, nickname)}


@router.patch("/local/devices/{mac}")
@router.patch("/user/devices/{mac}")
async def rename_device(mac: str, body: dict):
    mac = validate_mac_param(mac)
    if not await rename_local_device(mac, str(body.get("nickname") or "").strip()[:100]):
        raise HTTPException(404, "设备不存在")
    return {"ok": True}


@router.delete("/local/devices/{mac}")
@router.delete("/user/devices/{mac}")
async def unbind_user_device(mac: str, force: bool = False):
    # Removal only hides this device; configuration history/photos remain.
    if not await remove_local_device(validate_mac_param(mac)):
        raise HTTPException(404, "设备不存在")
    return {"ok": True}


def _mask_key(key: str) -> str:
    return "****" if key else ""


async def _settings() -> dict:
    config = await get_local_llm_config()
    if config:
        for field in ("api_key", "image_api_key"):
            config[field] = _mask_key(config.get(field) or "")
    return {"edition": "local", "auth_mode": "local", "llm_config": config,
            "preferences": await get_local_preferences()}


@router.get("/local/settings")
@router.get("/user/profile")
async def get_user_profile():
    return await _settings()


@router.put("/local/settings/llm")
@router.put("/user/profile/llm")
async def save_user_llm_config_route(body: dict):
    data = dict(body)
    if "llm_access_mode" in data:
        mode = str(data["llm_access_mode"] or "preset").strip().lower()
        if mode not in {"preset", "custom_openai"}:
            raise HTTPException(400, "无效的 AI 连接方式")
        data["llm_access_mode"] = mode
        if mode == "custom_openai":
            data["provider"] = "openai_compat"
    for field in ("base_url", "image_base_url"):
        value = str(data.get(field) or "").strip()
        if value and not value.startswith(("http://", "https://")):
            raise HTTPException(400, f"{field} 必须以 http:// 或 https:// 开头")
    await save_local_llm_config(data)
    return {"ok": True, "message": "配置已保存"}


@router.delete("/local/settings/llm")
@router.delete("/user/profile/llm")
async def delete_user_llm_config_route():
    return {"ok": True, "deleted": await delete_local_llm_config(), "message": "配置已删除"}


@router.put("/local/settings/preferences")
async def update_local_preferences(body: dict):
    if body.get("timezone"):
        try:
            ZoneInfo(str(body["timezone"]))
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(400, "无效时区")
    return {"ok": True, "preferences": await save_local_preferences(body)}


@router.get("/local/templates")
async def templates():
    return {"templates": await list_local_templates()}


@router.post("/local/templates/import")
async def import_template(body: dict):
    definition = body.get("definition", body)
    if not isinstance(definition, dict):
        raise HTTPException(400, "模板必须是 JSON 对象")
    valid, error = _validate_mode_def_with_error(definition)
    if not valid:
        raise HTTPException(400, error or "模板内容无效")
    metadata = {key: str(body[key])[:2000] for key in ("name", "description", "category") if key in body and isinstance(body[key], str)}
    template_id = await import_local_template(definition, metadata)
    return {"ok": True, "id": template_id}


@router.get("/local/templates/{template_id}/export")
async def export_template(template_id: int):
    for template in await list_local_templates():
        if template["id"] == template_id:
            return {"format": "inksight-template", "version": 1, "name": template["name"], "description": template["description"], "category": template["category"], "definition": template["definition"]}
    raise HTTPException(404, "模板不存在")


@router.delete("/local/templates/{template_id}")
async def delete_template(template_id: int):
    if not await delete_local_template(template_id):
        raise HTTPException(404, "模板不存在")
    return {"ok": True}
