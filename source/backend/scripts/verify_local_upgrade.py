"""Verify a real database upgrade on a new copy; never open the source writable.

Usage: python scripts/verify_local_upgrade.py --source /backup/inksight.db
       --destination /verification/upgrade.db --report /verification/upgrade.json
Keep the original ENCRYPTION_KEY in the test process environment.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def snapshot(path: Path) -> dict:
    with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as conn:
        result = {}
        for (table,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table'"):
            if table.startswith("sqlite_"):
                continue
            quoted = '"' + table.replace('"', '""') + '"'
            rows = conn.execute(f"SELECT * FROM {quoted}").fetchall()
            encoded = sorted(json.dumps(row, ensure_ascii=True, default=repr) for row in rows)
            result[table] = {"rows": len(rows), "sha256": hashlib.sha256("\n".join(encoded).encode()).hexdigest()}
        return result


async def verify(source: Path, destination: Path, report: Path) -> None:
    if source.resolve() == destination.resolve() or destination.exists():
        raise ValueError("destination must be a new database path distinct from the source")
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    before = snapshot(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # SQLite backup takes a consistent snapshot, including a source WAL if any.
    with sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True) as origin:
        with sqlite3.connect(destination) as target:
            origin.backup(target)
    from core import config_store, db, local_store
    db._MAIN_DB_PATH = str(destination)
    config_store.DB_PATH = str(destination)
    try:
        await config_store.init_db()
        first = snapshot(destination)
        await config_store.init_db()
        second = snapshot(destination)
        preserved = ("configs", "device_state", "users", "device_memberships", "user_devices", "user_llm_config", "custom_modes", "shared_modes", "device_claim_tokens", "render_logs", "device_heartbeats", "content_history")
        for table in preserved:
            if table in before:
                assert before[table] == first[table] == second[table], f"changed original table: {table}"
        for table in second:
            if table.startswith("local_"):
                assert first[table] == second[table], f"repeat migration changed {table}"
        with sqlite3.connect(destination) as conn:
            assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            owner_id = conn.execute("SELECT source_user_id FROM local_instance WHERE id=1").fetchone()[0]
            key_checks = {}
            if "user_llm_config" in before and owner_id is not None:
                columns = {r[1] for r in conn.execute("PRAGMA table_info(user_llm_config)")}
                for field in ("api_key", "image_api_key"):
                    if field in columns:
                        legacy = conn.execute(f"SELECT {field} FROM user_llm_config WHERE user_id=?", (owner_id,)).fetchone()
                        local = conn.execute(f"SELECT {field} FROM local_llm_config WHERE id=1").fetchone()
                        assert not legacy or legacy == local, f"ciphertext changed: {field}"
                        key_checks[field] = "unchanged" if legacy else "not configured"
        result = {
            "ok": True, "source_unchanged": hashlib.sha256(source.read_bytes()).hexdigest() == source_hash,
            "integrity": "ok", "idempotent": True,
            "preserved_tables": {table: before[table] for table in preserved if table in before},
            "local_tables": {table: second[table] for table in second if table.startswith("local_")},
            "encrypted_key_checks": key_checks,
            "managed_devices": len(await local_store.list_local_devices()),
        }
        assert result["source_unchanged"]
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"ok": True, "managed_devices": result["managed_devices"], "preserved_tables": len(result["preserved_tables"]), "report": str(report)}))
    finally:
        await db.close_all()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    asyncio.run(verify(args.source, args.destination, args.report))
