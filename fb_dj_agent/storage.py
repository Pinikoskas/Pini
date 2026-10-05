"""Remember which posts / people were already handled, so nobody gets messaged twice."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta


class Storage:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path)
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS actions (
                post_key   TEXT NOT NULL,
                author_url TEXT,
                action     TEXT NOT NULL,   -- comment / message / skip
                created_at TEXT NOT NULL,
                post_text  TEXT
            )"""
        )
        self.db.commit()

    def post_handled(self, post_key: str) -> bool:
        row = self.db.execute("SELECT 1 FROM actions WHERE post_key = ? LIMIT 1", (post_key,)).fetchone()
        return row is not None

    def author_messaged_recently(self, author_url: str, days: int) -> bool:
        since = (datetime.now() - timedelta(days=days)).isoformat()
        row = self.db.execute(
            "SELECT 1 FROM actions WHERE author_url = ? AND action = 'message' AND created_at >= ? LIMIT 1",
            (author_url, since),
        ).fetchone()
        return row is not None

    def record(self, post_key: str, author_url: str | None, action: str, post_text: str = "") -> None:
        self.db.execute(
            "INSERT INTO actions (post_key, author_url, action, created_at, post_text) VALUES (?, ?, ?, ?, ?)",
            (post_key, author_url, action, datetime.now().isoformat(), post_text[:500]),
        )
        self.db.commit()
