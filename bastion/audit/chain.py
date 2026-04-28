"""Hash-chained, signed appends on top of the audit store.

A record body is a plain dict. On append() this module:

  1. Reads the latest record's hash from the store (genesis if empty).
  2. Injects record_id, timestamp, previous_hash into the body.
  3. Canonicalizes the body to JSON (sorted keys, no whitespace).
  4. Hashes the canonical JSON with SHA-256.
  5. Signs the hash with the agent's Ed25519 private key.
  6. Persists everything via the store.

The verifier in verifier.py walks the chain and re-runs steps 3-5 plus the
chain-link check, so any mutation to a body, hash, signature, or link is
detected.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from cryptography.hazmat.primitives.asymmetric import ed25519

from bastion.audit.signer import sign
from bastion.audit.store import AuditStore


def canonical_json(obj: Any) -> bytes:
    """Deterministic JSON encoding: sorted keys, no whitespace, UTF-8."""
    return json.dumps(
        obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def hash_input(input_data: Any) -> str:
    """Hash arbitrary tool input data, returns hex string."""
    return sha256(canonical_json(input_data)).hex()


def now_iso() -> str:
    """ISO-8601 UTC timestamp with millisecond precision."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def append(
    store: AuditStore,
    body: dict[str, Any],
    private_key: ed25519.Ed25519PrivateKey,
) -> tuple[int, bytes]:
    """Append a signed record to the chain.

    Mutates a copy of `body` to inject record_id, timestamp, previous_hash.
    Returns (record_id, record_hash).
    """
    previous_hash = store.latest_hash()
    record_id = store.next_id()
    timestamp = now_iso()

    payload = dict(body)
    payload["record_id"] = record_id
    payload["timestamp"] = timestamp
    payload["previous_hash"] = previous_hash.hex()

    record_json_bytes = canonical_json(payload)
    record_hash = sha256(record_json_bytes)
    signature = sign(private_key, record_hash)

    store.append_record(
        record_json=record_json_bytes.decode("utf-8"),
        record_hash=record_hash,
        signature=signature,
        previous_hash=previous_hash,
        created_at=timestamp,
    )

    return record_id, record_hash
