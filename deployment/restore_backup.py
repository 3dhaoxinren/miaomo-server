"""Validate and restore a local backup while the backend is stopped.

Use restore.sh, which stops the application before running this in a one-shot
container. Never replace a SQLite file under a running application.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import tempfile
import zipfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

MAX_BYTES = 8 * 1024**3
MAX_FILES = 100_000


def validate_and_extract(archive: Path, target: Path) -> dict:
    """Extract only manifest-listed regular files; verify bytes before any swap."""
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        names = [entry.filename for entry in entries]
        if len(entries) > MAX_FILES or len(names) != len(set(names)):
            raise ValueError("Invalid or duplicate archive entries")
        if sum(entry.file_size for entry in entries) > MAX_BYTES:
            raise ValueError("Backup is too large")
        manifest_info = source.getinfo("manifest.json")
        if manifest_info.file_size > 32 * 1024**2:
            raise ValueError("Manifest is too large")
        manifest = json.loads(source.read("manifest.json"))
        if manifest.get("format") != "inksight-local-backup" or manifest.get("version") != 1:
            raise ValueError("Unsupported backup format")
        files = manifest.get("files", {})
        if not isinstance(files, dict) or "inksight.db" not in files:
            raise ValueError("Backup has no database")
        if set(names) != set(files) | {"manifest.json"}:
            raise ValueError("Archive entries differ from the manifest")
        for info in entries:
            name = info.filename
            path = PurePosixPath(name)
            if (path.is_absolute() or "\\" in name or ":" in name
                    or any(part in ("", ".", "..") or part.startswith(".") for part in path.parts)
                    or name != path.as_posix() or info.is_dir()
                    or stat.S_ISLNK(info.external_attr >> 16)):
                raise ValueError("Unsafe archive path")
            if name == "manifest.json":
                continue
            if name != "inksight.db" and not name.startswith("uploads/"):
                raise ValueError("Unexpected backup file")
            record = files[name]
            if not isinstance(record, dict) or record.get("bytes") != info.file_size:
                raise ValueError("File size does not match manifest")
            destination = target.joinpath(*path.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            size = 0
            with source.open(info) as inp, destination.open("xb") as out:
                while chunk := inp.read(1024 * 1024):
                    size += len(chunk)
                    if size > info.file_size:
                        raise ValueError("Unexpected expanded size")
                    out.write(chunk)
                    digest.update(chunk)
            if size != info.file_size or digest.hexdigest() != record.get("sha256"):
                raise ValueError("File checksum does not match manifest")
    with closing(sqlite3.connect((target / "inksight.db").as_uri() + "?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Invalid SQLite database")
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"configs", "device_state"}.issubset(tables):
            raise ValueError("Not an InkSight database")
    (target / "uploads").mkdir(exist_ok=True)
    return manifest


def restore(archive: Path, data: Path) -> Path:
    data = data.resolve(strict=True)
    if data == Path(data.anchor) or data.is_symlink():
        raise ValueError("A dedicated data directory is required")
    lock = data / ".restore.lock"
    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    staging = Path(tempfile.mkdtemp(prefix=".restore-staging-", dir=data))
    rollback = data / ("restore-rollback-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f"))
    saved: list[str] = []
    installed: list[str] = []
    try:
        validate_and_extract(archive.resolve(strict=True), staging)
        rollback.mkdir()
        # Cache is regenerated from the restored settings. Preserve it in rollback.
        for name in ("inksight.db", "inksight.db-wal", "inksight.db-shm", "cache.db", "cache.db-wal", "cache.db-shm", "uploads"):
            current = data / name
            if current.is_symlink():
                raise ValueError("Unexpected symlink in data directory")
            if current.exists():
                current.replace(rollback / name)
                saved.append(name)
        for name in ("inksight.db", "uploads"):
            (staging / name).replace(data / name)
            installed.append(name)
        return rollback
    except BaseException:
        for name in reversed(installed):
            (data / name).replace(staging / name)
        for name in reversed(saved):
            (rollback / name).replace(data / name)
        raise
    finally:
        shutil.rmtree(staging)
        lock.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--data-dir", type=Path, default=Path("/data"))
    parser.add_argument("--service-stopped", action="store_true", required=True)
    args = parser.parse_args()
    rollback_path = restore(args.archive, args.data_dir)
    print(json.dumps({"restored": True, "rollback": str(rollback_path)}))
