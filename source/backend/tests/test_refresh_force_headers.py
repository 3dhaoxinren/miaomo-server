"""HTTP contract for one-shot physical refresh through the author's force header."""
import asyncio
import io
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from PIL import Image

from api.routes import device as device_routes
from api.routes import render as render_routes


MAC = "AA:BB:CC:DD:EE:03"
PARAMS = {"mac": MAC, "w": 400, "h": 300, "colors": 4}


@pytest.fixture
def wired(monkeypatch):
    # Exercise real routers and serialization while keeping all device data in RAM.
    state = {"pending": False}
    image = Image.new("P", (400, 300), 1)
    image.putpalette([0, 0, 0, 255, 255, 255, 232, 176, 0, 200, 0, 0] + [0] * 756)
    result = (image, "MY_ADAPTIVE", False, False, False, False, False, "local_api_key")
    async def set_pending(_mac, pending=True):
        state["pending"] = bool(pending)
    async def consume(_mac):
        pending = state["pending"]
        state["pending"] = False
        return pending
    queue = {}
    build = AsyncMock(return_value=result)
    consume_mock = AsyncMock(side_effect=consume)
    owner = AsyncMock(return_value={"user_id": 1})
    monkeypatch.setattr(device_routes, "ensure_web_or_device_access", AsyncMock(return_value={"mode": "device"}))
    monkeypatch.setattr(device_routes, "set_pending_refresh", AsyncMock(side_effect=set_pending))
    monkeypatch.setattr(render_routes, "require_device_token", AsyncMock(return_value=True))
    monkeypatch.setattr(render_routes, "get_active_config", AsyncMock(return_value={"refresh_interval": 30, "modes": ["MY_ADAPTIVE"]}))
    monkeypatch.setattr(render_routes, "get_device_owner", owner)
    monkeypatch.setattr(render_routes, "get_device_state", AsyncMock(return_value={}))
    monkeypatch.setattr(render_routes, "get_latest_heartbeat", AsyncMock(return_value=None))
    monkeypatch.setattr(render_routes, "build_image", build)
    monkeypatch.setattr(render_routes, "log_render_stats", AsyncMock())
    monkeypatch.setattr(render_routes, "update_device_state", AsyncMock())
    monkeypatch.setattr(render_routes, "consume_pending_refresh", consume_mock)
    monkeypatch.setattr(render_routes, "_preview_push_queue", queue)
    monkeypatch.setattr(render_routes, "_preview_push_queue_lock", asyncio.Lock())
    monkeypatch.setattr(render_routes, "_render_device_unbound_image", lambda *args: image)
    monkeypatch.setattr(render_routes, "render_error", lambda **kwargs: image)
    monkeypatch.setattr(render_routes.limiter, "enabled", False)
    app = FastAPI()
    app.state.limiter = render_routes.limiter
    app.include_router(device_routes.router, prefix="/api")
    app.include_router(render_routes.router, prefix="/api")
    return SimpleNamespace(app=app, state=state, build=build, consume=consume_mock,
                           owner=owner, queue=queue, image=image, result=result)


@pytest.mark.asyncio
@pytest.mark.parametrize("cache_hit", [False, True])
async def test_manual_refresh_forces_same_frame_once_even_on_cache_hit(wired, cache_hit):
    result = list(wired.result)
    result[2] = cache_hit
    wired.build.return_value = tuple(result)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=wired.app), base_url="http://test") as client:
        ordinary = await client.get("/api/render", params=PARAMS)
        queued = await client.post(f"/api/device/{MAC}/refresh")
        assert queued.status_code == 200 and wired.state["pending"] is True
        forced = await client.get("/api/render", params=PARAMS)
        after = await client.get("/api/render", params=PARAMS)
    assert ordinary.status_code == forced.status_code == after.status_code == 200
    assert ordinary.content == forced.content == after.content
    assert forced.headers["x-pending-refresh"] == "1"
    assert forced.headers["x-preview-push"] == "1"
    assert forced.headers["x-cache-hit"] == str(int(cache_hit))
    assert wired.state["pending"] is False
    for response in (ordinary, after):
        assert "x-pending-refresh" not in response.headers
        assert "x-preview-push" not in response.headers


@pytest.mark.asyncio
async def test_failed_render_keeps_pending_and_successful_retry_gets_force(wired):
    wired.state["pending"] = True
    wired.build.side_effect = RuntimeError("controlled render failure")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=wired.app), base_url="http://test") as client:
        failed = await client.get("/api/render", params=PARAMS)
        assert failed.status_code == 500
        assert wired.state["pending"] is True
        wired.consume.assert_not_awaited()
        assert "x-preview-push" not in failed.headers
        assert "x-pending-refresh" not in failed.headers
        wired.build.side_effect = None
        retry = await client.get("/api/render", params=PARAMS)
    assert retry.status_code == 200
    assert retry.headers["x-preview-push"] == retry.headers["x-pending-refresh"] == "1"
    assert wired.state["pending"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("pending", [False, True])
async def test_real_preview_push_keeps_existing_force_header_and_queue_semantics(wired, pending):
    encoded = io.BytesIO()
    wired.image.save(encoded, format="PNG")
    wired.queue[MAC] = {"image": encoded.getvalue(), "mode": "MY_ADAPTIVE"}
    wired.state["pending"] = pending
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=wired.app), base_url="http://test") as client:
        pushed = await client.get("/api/render", params=PARAMS)
        assert pushed.status_code == 200
        assert pushed.headers["x-preview-push"] == "1"
        assert (pushed.headers.get("x-pending-refresh") == "1") is pending
        assert MAC not in wired.queue and wired.state["pending"] is False
        wired.build.assert_not_awaited()
        ordinary = await client.get("/api/render", params=PARAMS)
    assert ordinary.status_code == 200
    assert ordinary.content == pushed.content
    assert "x-preview-push" not in ordinary.headers


@pytest.mark.asyncio
@pytest.mark.parametrize("pending", [False, True])
async def test_unbound_response_only_forces_when_pending_is_consumed(wired, pending):
    wired.owner.return_value = None
    wired.state["pending"] = pending
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=wired.app), base_url="http://test") as client:
        response = await client.get("/api/render", params=PARAMS)
    assert response.status_code == 200
    assert (response.headers.get("x-preview-push") == "1") is pending
    assert (response.headers.get("x-pending-refresh") == "1") is pending
    assert wired.state["pending"] is False
    wired.build.assert_not_awaited()


@pytest.mark.asyncio
async def test_device_auth_failure_does_not_consume_or_force(wired, monkeypatch):
    wired.state["pending"] = True
    monkeypatch.setattr(render_routes, "require_device_token", AsyncMock(side_effect=HTTPException(status_code=401)))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=wired.app), base_url="http://test") as client:
        response = await client.get("/api/render", params=PARAMS)
    assert response.status_code == 401
    assert wired.state["pending"] is True
    wired.consume.assert_not_awaited()
    wired.build.assert_not_awaited()
    assert "x-preview-push" not in response.headers
