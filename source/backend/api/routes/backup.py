"""Download a consistent local database snapshot and its uploaded photo files."""
from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import sqlite3
import tempfile
import zipfile
from datetime import datetime, timezone
from contextlib import closing
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from core import db
from core.auth import require_user

router = APIRouter(tags=["local-backup"])
_backup_lock = asyncio.Lock()


def create_archive(database: Path, uploads: Path, destination: Path) -> Path:
    """Called in a worker thread. Never read environment credentials into the ZIP."""
    destination.mkdir(parents=True, exist_ok=True)
    snapshot = destination / "inksight.db"
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as source:
        with closing(sqlite3.connect(snapshot)) as target:
            source.backup(target, pages=256)
            if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("Database snapshot failed integrity check")

    archive = destination / "inksight-backup.zip"
    manifest = {
        "format": "inksight-local-backup", "version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "restore": "offline; keep the original backend.env encryption configuration",
        "files": {},
    }
    root = uploads.resolve()
    sources = [("inksight.db", snapshot)]
    if root.is_dir():
        for path in sorted(root.rglob("*")):
            relative = path.relative_to(root)
            if path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(root):
                if not any(part.startswith(".") for part in relative.parts):
                    sources.append(("uploads/" + relative.as_posix(), path))
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
        for name, path in sources:
            digest = hashlib.sha256()
            size = 0
            with path.open("rb") as source, output.open(name, "w", force_zip64=True) as target:
                while chunk := source.read(1024 * 1024):
                    target.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
            manifest["files"][name] = {"sha256": digest.hexdigest(), "bytes": size}
        output.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    snapshot.unlink()
    return archive


@router.get("/local/backup")
async def download_backup(request: Request):
    await require_user(request)
    if _backup_lock.locked():
        raise HTTPException(429, "正在生成备份，请稍后再试")
    from api.routes.uploads import _UPLOAD_DIR

    folder = Path(tempfile.mkdtemp(prefix="inksight-backup-"))
    try:
        async with _backup_lock:
            archive = await asyncio.to_thread(create_archive, Path(db._MAIN_DB_PATH), _UPLOAD_DIR, folder)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        return FileResponse(
            archive, media_type="application/zip", filename=f"inksight-local-{stamp}.zip",
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
            background=BackgroundTask(shutil.rmtree, folder, ignore_errors=True),
        )
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise
