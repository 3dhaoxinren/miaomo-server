import importlib
from unittest.mock import AsyncMock
import httpx
import pytest

route = importlib.import_module("api.routes.render")
from api.index import app

@pytest.mark.asyncio
@pytest.mark.parametrize("colors, expected_type", [(4,"application/octet-stream"),(3,"application/octet-stream"),(2,"image/bmp")])
async def test_unbound_device_uses_requested_color_transport(monkeypatch,colors,expected_type):
    monkeypatch.setattr(route,"require_device_token",AsyncMock(return_value=True))
    monkeypatch.setattr(route,"get_active_config",AsyncMock(return_value={"refresh_interval":60}))
    monkeypatch.setattr(route,"get_device_owner",AsyncMock(return_value=None))
    monkeypatch.setattr(route,"get_or_create_claim_token",AsyncMock(return_value={"pair_code":"TEST1234"}))
    monkeypatch.setattr(route,"consume_pending_refresh",AsyncMock(return_value=False))
    async with httpx.AsyncClient(app=app,base_url="http://test") as client:
        response=await client.get("/api/render",params={"mac":"01:02:03:04:05:06","w":768,"h":552,"colors":colors})
    assert response.status_code==200
    assert response.headers["content-type"]==expected_type
    assert response.headers["x-refresh-minutes"]=="60"
    if colors>=3:
        assert len(response.content)==105984
        assert not response.content.startswith(b"BM")
    else:
        assert response.content.startswith(b"BM")

@pytest.mark.asyncio
@pytest.mark.parametrize("colors, expected_type", [(4,"application/octet-stream"),(3,"application/octet-stream"),(2,"image/bmp")])
async def test_render_error_uses_requested_color_transport(monkeypatch,colors,expected_type):
    monkeypatch.setattr(route,"build_image",AsyncMock(side_effect=RuntimeError("controlled render failure")))
    async with httpx.AsyncClient(app=app,base_url="http://test") as client:
        response=await client.get("/api/render",params={"w":768,"h":552,"colors":colors})
    assert response.status_code==500
    assert response.headers["content-type"]==expected_type
    if colors>=3:
        assert len(response.content)==105984
        assert not response.content.startswith(b"BM")
    else:
        assert response.content.startswith(b"BM")
