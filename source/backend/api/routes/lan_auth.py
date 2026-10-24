"""Compatibility identity for older clients. No account endpoints."""
from fastapi import APIRouter
from core.auth import get_local_user
router = APIRouter(tags=["local"])

@router.get("/auth/me")
async def local_identity():
    return await get_local_user()
