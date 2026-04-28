"""End-to-end tests for the public Bastion SDK class."""

from __future__ import annotations

import json

import pytest

from bastion import Bastion, policy


@pytest.fixture
def bastion_in_tmp(tmp_path):
    """A Bastion with code-only policies, isolated under tmp_path."""
    keys_dir = tmp_path / "keys"
    db_path = tmp_path / "agent.db"
    b = Bastion(
        agent_id="test-agent",
        policies=[
            policy.deny.tools("delete_file"),
            policy.deny.paths("/etc/*"),
            policy.deny.above("amount", 1000),
            policy.escalate.above("amount", 30),
        ],
        db_path=db_path,
        keys_dir=keys_dir,
    )
    yield b
    b.close()


def test_construction_creates_keys_and_db(tmp_path):
    keys_dir = tmp_path / "keys"
    db_path = tmp_path / "x.db"
    b = Bastion(agent_id="t", db_path=db_path, keys_dir=keys_dir)
    assert (keys_dir / "private.pem").exists()
    assert (keys_dir / "public.pem").exists()
    assert db_path.exists()
    assert b.fingerprint and len(b.fingerprint) == 16
    b.close()


def test_auto_init_false_raises_when_uninitialized(tmp_path):
    with pytest.raises(FileNotFoundError):
        Bastion(
            agent_id="t",
            db_path=tmp_path / "x.db",
            keys_dir=tmp_path / "keys",
            auto_init=False,
        )


def test_evaluate_allow_writes_one_record(bastion_in_tmp):
    decision = bastion_in_tmp.evaluate("Read", {"path": "/tmp/x"})
    assert decision.outcome == "allow"
    assert bastion_in_tmp.store.count() == 1


def test_evaluate_deny_writes_one_record(bastion_in_tmp):
    decision = bastion_in_tmp.evaluate("delete_file", {"path": "/tmp/x"})
    assert decision.outcome == "deny"
    assert bastion_in_tmp.store.count() == 1


def test_evaluate_path_deny(bastion_in_tmp):
    decision = bastion_in_tmp.evaluate("Write", {"path": "/etc/passwd"})
    assert decision.outcome == "deny"


def test_evaluate_with_hitl_writes_two_records(tmp_path):
    """Escalate -> HITL approve should append both records."""
    keys_dir = tmp_path / "keys"
    db_path = tmp_path / "agent.db"

    def auto_approve(decision, tool_name, input_data):
        from bastion.policy.schema import Decision
        return Decision(
            outcome="allow",
            source="human",
            policy_id="human.approved",
            reason="auto-approved for test",
        )

    b = Bastion(
        agent_id="t",
        policies=[policy.escalate.above("amount", 30)],
        hitl_handler=auto_approve,
        db_path=db_path,
        keys_dir=keys_dir,
    )
    decision = b.evaluate("charge", {"amount": 200})
    assert decision.outcome == "allow"
    assert decision.source == "human"
    assert b.store.count() == 2

    records = b.store.iter_records()
    bodies = [json.loads(r.record_json) for r in records]
    assert bodies[0]["event"] == "policy_decision"
    assert bodies[0]["decision"] == "escalate"
    assert bodies[1]["event"] == "hitl_decision"
    assert bodies[1]["decision"] == "allow"
    b.close()


def test_record_outcome_appends_linked_record(bastion_in_tmp):
    decision = bastion_in_tmp.evaluate("Read", {"path": "/tmp/x"})
    assert decision.outcome == "allow"
    decision_id = bastion_in_tmp.last_decision_record_id

    outcome_id = bastion_in_tmp.record_outcome(success=True, output_hash="abc123", tool_name="Read")
    assert outcome_id == decision_id + 1
    rec = bastion_in_tmp.store.get_record(outcome_id)
    body = json.loads(rec.record_json)
    assert body["event"] == "tool_outcome"
    assert body["links_decision_id"] == decision_id
    assert body["success"] is True
    assert body["output_hash"] == "abc123"


def test_record_outcome_failure(bastion_in_tmp):
    bastion_in_tmp.evaluate("Read", {"path": "/tmp/x"})
    outcome_id = bastion_in_tmp.record_outcome(
        success=False, error="connection refused", tool_name="Read"
    )
    body = json.loads(bastion_in_tmp.store.get_record(outcome_id).record_json)
    assert body["success"] is False
    assert body["error"] == "connection refused"


def test_verify_passes_after_realistic_session(bastion_in_tmp):
    bastion_in_tmp.evaluate("Read", {"path": "/tmp/a"})
    bastion_in_tmp.record_outcome(success=True, output_hash="x", tool_name="Read")
    bastion_in_tmp.evaluate("delete_file", {"path": "/tmp/b"})
    bastion_in_tmp.evaluate("Read", {"path": "/tmp/c"})
    bastion_in_tmp.record_outcome(success=True, output_hash="y", tool_name="Read")

    report = bastion_in_tmp.verify()
    assert report.is_clean
    assert report.total == bastion_in_tmp.store.count()


def test_report_returns_table_with_correct_row_count(bastion_in_tmp):
    bastion_in_tmp.evaluate("Read", {"path": "/tmp/a"})
    bastion_in_tmp.evaluate("delete_file", {"path": "/tmp/b"})
    bastion_in_tmp.record_outcome(success=True, tool_name="Read")

    table = bastion_in_tmp.report()
    assert table.row_count == 3


def test_unsafe_agent_id_rejected(tmp_path):
    with pytest.raises(ValueError):
        Bastion(agent_id="../escape", db_path=tmp_path / "x.db", keys_dir=tmp_path / "k")


def test_keys_persist_across_constructor_invocations(tmp_path):
    keys_dir = tmp_path / "keys"
    db_path = tmp_path / "agent.db"
    b1 = Bastion(agent_id="t", db_path=db_path, keys_dir=keys_dir)
    fp1 = b1.fingerprint
    b1.close()

    b2 = Bastion(agent_id="t", db_path=db_path, keys_dir=keys_dir)
    assert b2.fingerprint == fp1
    b2.close()
