"""Tests for the signed append-only audit chain."""

from __future__ import annotations

import json
import sqlite3

import pytest

from bastion.audit.chain import append, canonical_json, hash_input, sha256
from bastion.audit.signer import generate_keypair, load_private_key, load_public_key
from bastion.audit.store import GENESIS_HASH, AuditStore
from bastion.audit.verifier import verify_chain


@pytest.fixture
def keys():
    private_pem, public_pem = generate_keypair()
    return load_private_key(private_pem), load_public_key(public_pem)


@pytest.fixture
def store(tmp_path):
    db_path = tmp_path / "test.db"
    s = AuditStore(db_path)
    yield s
    s.close()


def _make_body(i: int) -> dict:
    return {
        "event": "policy_decision",
        "agent_id": "test-agent",
        "tool_name": f"Tool{i}",
        "tool_input_hash": "0" * 64,
        "decision": "allow",
        "decision_source": "code_policy",
        "policy_id": f"test:{i}",
        "reason": f"step {i}",
        "latency_ms": 1,
    }


def test_canonical_json_is_deterministic_across_key_orders():
    a = {"b": 2, "a": 1, "c": [3, 1, 2]}
    b = {"a": 1, "c": [3, 1, 2], "b": 2}
    assert canonical_json(a) == canonical_json(b)


def test_sha256_hash_input_returns_64_char_hex():
    digest = hash_input({"foo": "bar"})
    assert isinstance(digest, str)
    assert len(digest) == 64
    int(digest, 16)


def test_genesis_hash_used_for_first_record(store, keys):
    private_key, _ = keys
    rid, _ = append(store, _make_body(0), private_key)
    rec = store.get_record(rid)
    assert rec.previous_hash == GENESIS_HASH


def test_chain_validates_after_100_appends(store, keys):
    private_key, public_key = keys
    for i in range(100):
        append(store, _make_body(i), private_key)

    report = verify_chain(store, public_key)
    assert report.total == 100
    assert report.valid == 100
    assert report.is_clean
    assert report.first_failure_id is None


def test_each_record_includes_chain_metadata(store, keys):
    private_key, _ = keys
    rid1, _ = append(store, _make_body(1), private_key)
    rid2, hash2 = append(store, _make_body(2), private_key)

    rec1 = store.get_record(rid1)
    rec2 = store.get_record(rid2)
    body2 = json.loads(rec2.record_json)

    assert body2["record_id"] == rid2
    assert body2["previous_hash"] == rec1.record_hash.hex()
    assert "timestamp" in body2
    assert sha256(canonical_json(body2)) == hash2


def test_tamper_detection_on_body_mutation(store, keys):
    private_key, public_key = keys
    for i in range(100):
        append(store, _make_body(i), private_key)
    db_path = store.path
    store.close()

    conn = sqlite3.connect(str(db_path))
    original = conn.execute(
        "SELECT record_json FROM audit_records WHERE id = 42"
    ).fetchone()[0]
    body = json.loads(original)
    body["tool_name"] = "MUTATED"
    mutated = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    conn.execute(
        "UPDATE audit_records SET record_json = ? WHERE id = 42", (mutated,)
    )
    conn.commit()
    conn.close()

    store2 = AuditStore(db_path)
    report = verify_chain(store2, public_key)
    store2.close()

    assert not report.is_clean
    assert report.first_failure_id == 42
    assert any("body tampered" in f.reason or "hash mismatch" in f.reason
               for f in report.failures)

    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "UPDATE audit_records SET record_json = ? WHERE id = 42", (original,)
    )
    conn.commit()
    conn.close()

    store3 = AuditStore(db_path)
    report2 = verify_chain(store3, public_key)
    store3.close()
    assert report2.is_clean


def test_tamper_detection_on_chain_link_mutation(store, keys):
    private_key, public_key = keys
    for i in range(50):
        append(store, _make_body(i), private_key)
    db_path = store.path
    store.close()

    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "UPDATE audit_records SET previous_hash = ? WHERE id = 42",
        (b"\xff" * 32,),
    )
    conn.commit()
    conn.close()

    store2 = AuditStore(db_path)
    report = verify_chain(store2, public_key)
    store2.close()

    assert not report.is_clean
    assert report.first_failure_id == 42


def test_tamper_detection_on_signature_mutation(store, keys):
    private_key, public_key = keys
    for i in range(20):
        append(store, _make_body(i), private_key)
    db_path = store.path
    store.close()

    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "UPDATE audit_records SET signature = ? WHERE id = 10",
        (b"\x00" * 64,),
    )
    conn.commit()
    conn.close()

    store2 = AuditStore(db_path)
    report = verify_chain(store2, public_key)
    store2.close()

    assert not report.is_clean
    assert report.first_failure_id == 10


def test_verifier_returns_zero_for_empty_chain(store, keys):
    _, public_key = keys
    report = verify_chain(store, public_key)
    assert report.total == 0
    assert report.valid == 0
    assert report.is_clean
