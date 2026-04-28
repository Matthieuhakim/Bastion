"""SQLite-backed append-only audit store."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path

GENESIS_HASH: bytes = b"\x00" * 32


@dataclass(frozen=True)
class StoredRecord:
    id: int
    record_json: str
    record_hash: bytes
    signature: bytes
    previous_hash: bytes
    created_at: str


_SCHEMA = """
CREATE TABLE IF NOT EXISTS audit_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_json TEXT NOT NULL,
    record_hash BLOB NOT NULL,
    signature BLOB NOT NULL,
    previous_hash BLOB NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_created_at ON audit_records(created_at);
"""


class AuditStore:
    """Append-only signed audit store. One file per agent."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def append_record(
        self,
        record_json: str,
        record_hash: bytes,
        signature: bytes,
        previous_hash: bytes,
        created_at: str,
    ) -> int:
        cur = self._conn.execute(
            "INSERT INTO audit_records "
            "(record_json, record_hash, signature, previous_hash, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (record_json, record_hash, signature, previous_hash, created_at),
        )
        self._conn.commit()
        return int(cur.lastrowid)

    def get_record(self, record_id: int) -> StoredRecord | None:
        row = self._conn.execute(
            "SELECT id, record_json, record_hash, signature, previous_hash, created_at "
            "FROM audit_records WHERE id = ?",
            (record_id,),
        ).fetchone()
        return StoredRecord(*row) if row else None

    def iter_records(self, agent_id: str | None = None) -> list[StoredRecord]:
        rows = self._conn.execute(
            "SELECT id, record_json, record_hash, signature, previous_hash, created_at "
            "FROM audit_records ORDER BY id ASC"
        ).fetchall()
        records = [StoredRecord(*r) for r in rows]
        if agent_id is None:
            return records
        return [
            r for r in records if json.loads(r.record_json).get("agent_id") == agent_id
        ]

    def latest_record(self) -> StoredRecord | None:
        row = self._conn.execute(
            "SELECT id, record_json, record_hash, signature, previous_hash, created_at "
            "FROM audit_records ORDER BY id DESC LIMIT 1"
        ).fetchone()
        return StoredRecord(*row) if row else None

    def latest_hash(self) -> bytes:
        rec = self.latest_record()
        return rec.record_hash if rec else GENESIS_HASH

    def next_id(self) -> int:
        row = self._conn.execute(
            "SELECT COALESCE(MAX(id), 0) + 1 FROM audit_records"
        ).fetchone()
        return int(row[0])

    def count(self) -> int:
        row = self._conn.execute("SELECT COUNT(*) FROM audit_records").fetchone()
        return int(row[0])

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> AuditStore:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
