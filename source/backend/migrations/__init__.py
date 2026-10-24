from __future__ import annotations

from datetime import datetime


async def _column_exists(db, table: str, column: str) -> bool:
    cursor = await db.execute(f"PRAGMA table_info({table})")
    rows = await cursor.fetchall()
    return any(row[1] == column for row in rows)


async def _add_column_if_missing(db, table: str, column: str, ddl: str) -> None:
    if await _column_exists(db, table, column):
        return
    await db.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


async def run_main_db_migrations(db, *, defaults: dict[str, str]) -> None:
    await db.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_versions (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL
        )
        """
    )
    cursor = await db.execute("SELECT version FROM schema_versions")
    applied_versions = {row[0] for row in await cursor.fetchall()}

    migrations = [
        (1, "configs.countdown_events", lambda: _add_column_if_missing(db, "configs", "countdown_events", "countdown_events TEXT DEFAULT '[]'")),
        (2, "configs.time_slot_rules", lambda: _add_column_if_missing(db, "configs", "time_slot_rules", "time_slot_rules TEXT DEFAULT '[]'")),
        (3, "configs.memo_text", lambda: _add_column_if_missing(db, "configs", "memo_text", "memo_text TEXT DEFAULT ''")),
        (5, "configs.image_provider", lambda: _add_column_if_missing(db, "configs", "image_provider", f"image_provider TEXT DEFAULT '{defaults['image_provider']}'")),
        (6, "configs.image_model", lambda: _add_column_if_missing(db, "configs", "image_model", f"image_model TEXT DEFAULT '{defaults['image_model']}'")),
        (8, "configs.mode_overrides", lambda: _add_column_if_missing(db, "configs", "mode_overrides", "mode_overrides TEXT DEFAULT '{}'")),
        (9, "device_state.pending_mode", lambda: _add_column_if_missing(db, "device_state", "pending_mode", "pending_mode TEXT DEFAULT ''")),
        (10, "device_state.last_state_poll_at", lambda: _add_column_if_missing(db, "device_state", "last_state_poll_at", "last_state_poll_at TEXT DEFAULT ''")),
        (11, "device_state.auth_token", lambda: _add_column_if_missing(db, "device_state", "auth_token", "auth_token TEXT DEFAULT ''")),
        (12, "device_state.runtime_mode", lambda: _add_column_if_missing(db, "device_state", "runtime_mode", "runtime_mode TEXT DEFAULT 'interval'")),
        (13, "device_state.expected_refresh_min", lambda: _add_column_if_missing(db, "device_state", "expected_refresh_min", "expected_refresh_min INTEGER DEFAULT 0")),
        (14, "device_state.last_reconnect_regen_at", lambda: _add_column_if_missing(db, "device_state", "last_reconnect_regen_at", "last_reconnect_regen_at TEXT DEFAULT ''")),
        (18, "configs.latitude", lambda: _add_column_if_missing(db, "configs", "latitude", "latitude REAL")),
        (19, "configs.longitude", lambda: _add_column_if_missing(db, "configs", "longitude", "longitude REAL")),
        (20, "configs.timezone", lambda: _add_column_if_missing(db, "configs", "timezone", "timezone TEXT DEFAULT ''")),
        (21, "configs.admin1", lambda: _add_column_if_missing(db, "configs", "admin1", "admin1 TEXT DEFAULT ''")),
        (22, "configs.country", lambda: _add_column_if_missing(db, "configs", "country", "country TEXT DEFAULT ''")),
        (23, "device_state.ota_original_url", lambda: _add_column_if_missing(db, "device_state", "ota_original_url", "ota_original_url TEXT DEFAULT ''")),
        (
            25,
            "vocab_review.create",
            lambda: db.executescript(
                """
                CREATE TABLE IF NOT EXISTS vocab_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    deck_id TEXT NOT NULL,
                    word TEXT NOT NULL,
                    phonetic TEXT DEFAULT '',
                    definition TEXT NOT NULL,
                    example TEXT DEFAULT '',
                    difficulty INTEGER DEFAULT 1,
                    created_at TEXT NOT NULL,
                    UNIQUE(deck_id, word)
                );
                CREATE INDEX IF NOT EXISTS idx_vocab_items_deck
                    ON vocab_items(deck_id, difficulty, id);

                CREATE TABLE IF NOT EXISTS vocab_progress (
                    mac TEXT NOT NULL,
                    vocab_item_id INTEGER NOT NULL,
                    due_at TEXT NOT NULL,
                    interval_days INTEGER DEFAULT 0,
                    ease_factor REAL DEFAULT 2.5,
                    repetitions INTEGER DEFAULT 0,
                    lapses INTEGER DEFAULT 0,
                    last_grade TEXT DEFAULT '',
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(mac, vocab_item_id),
                    FOREIGN KEY(vocab_item_id) REFERENCES vocab_items(id)
                );
                CREATE INDEX IF NOT EXISTS idx_vocab_progress_due
                    ON vocab_progress(mac, due_at);

                CREATE TABLE IF NOT EXISTS vocab_session_state (
                    mac TEXT PRIMARY KEY,
                    deck_id TEXT DEFAULT 'core_en',
                    current_item_id INTEGER,
                    side TEXT DEFAULT 'front',
                    rating_cursor INTEGER DEFAULT 0,
                    review_date TEXT DEFAULT '',
                    reviewed_count INTEGER DEFAULT 0,
                    new_count INTEGER DEFAULT 0,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(current_item_id) REFERENCES vocab_items(id)
                );
                """
            ),
        ),
    ]

    now = datetime.now().isoformat()
    for version, name, apply in migrations:
        if version in applied_versions:
            continue
        await apply()
        await db.execute(
            "INSERT INTO schema_versions (version, name, applied_at) VALUES (?, ?, ?)",
            (version, name, now),
        )

    await db.commit()
