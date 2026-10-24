"""Local control-plane compatibility and device-token validation.

The LAN deployment has no accounts, passwords, sessions, or user JWTs.
Origin and Host validation in api.index remains the browser trust boundary.
"""
from __future__ import annotations
import hmac
import logging
import os
import re
from typing import Optional
from fastapi import Header, HTTPException, Request
from .config_store import validate_device_token, get_device_state
from .i18n import msg, normalize_lang

logger = logging.getLogger(__name__)
_MAC_RE = re.compile(r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")

async def get_local_user() -> dict:
    # This ID is a compatibility field, not a row in the old users table.
    return {"user_id": 1, "username": "local", "role": "local", "auth_mode": "local", "edition": "local"}

async def require_user(request: Request, ink_session: Optional[str] = None) -> int:
    return 1

async def optional_user(request: Request, ink_session: Optional[str] = None) -> int:
    return 1

async def get_current_user_optional(request: Request, ink_session: Optional[str] = None) -> dict:
    return await get_local_user()


def require_admin(authorization: Optional[str] = Header(default=None), accept_language: Optional[str] = Header(default=None, alias="Accept-Language")) -> None:
    # Local maintenance is available in the trusted LAN console. A supplied
    # administrative token is still validated, rather than silently ignored.
    if authorization and not is_admin_authorized(authorization):
        raise HTTPException(status_code=403, detail=msg("auth.admin_required", normalize_lang(accept_language)))

def validate_mac_param(mac: str, lang: str = "zh") -> str:
    """校验并规范化 MAC 地址路径参数。

    返回大写 MAC，格式无效时抛出 400。
    """
    if not mac or not _MAC_RE.match(mac):
        raise HTTPException(status_code=400, detail=msg("auth.invalid_mac_format", normalize_lang(lang)))
    return mac.upper()


def is_admin_authorized(authorization: Optional[str]) -> bool:
    admin_token = os.environ.get("ADMIN_TOKEN")
    if not admin_token:
        return False
    if not authorization:
        return False

    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0] != "Bearer":
        return False
    return hmac.compare_digest(parts[1], admin_token)


async def require_device_token(
    mac: str,
    x_device_token: Optional[str] = Header(default=None),
    accept_language: Optional[str] = Header(default=None, alias="Accept-Language"),
) -> bool:
    lang = normalize_lang(accept_language)
    if x_device_token:
        valid = await validate_device_token(mac, x_device_token)
        if valid:
            return True

    state = await get_device_state(mac)
    if state and state.get("auth_token"):
        logger.warning(f"[AUTH] 设备 Token 校验失败: {mac}")
        raise HTTPException(status_code=401, detail=msg("auth.device_token_invalid", lang))
    raise HTTPException(status_code=401, detail=msg("auth.device_token_required", lang))
