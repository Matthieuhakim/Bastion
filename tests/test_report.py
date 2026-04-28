"""Tests for Bastion.report() and Bastion.summary_stats()."""

from __future__ import annotations

import json

import pytest
from rich.table import Table

from bastion import Bastion, policy
from bastion.policy.schema import Decision


@pytest.fixture
def populated_bastion(tmp_path):
    """Bastion with a realistic mix of records."""
    def auto_approve(decision, tool_name, input_data):
        return Decision(
            outcome="allow",
            source="human",
            policy_id="human.approved",
            reason="auto-approved",
        )

    b = Bastion(
        agent_id="report-test",
        policies=[
            policy.deny.tools("delete_file"),
            policy.deny.above("amount", 1000),
            policy.escalate.above("amount", 30),
        ],
        hitl_handler=auto_approve,
        db_path=tmp_path / "audit.db",
        keys_dir=tmp_path / "keys",
    )

    b.evaluate("Read", {"path": "/tmp/x"})
    b.record_outcome(success=True, output_hash="abc", tool_name="Read")
    b.evaluate("delete_file", {"path": "/tmp/y"})  # deny
    b.evaluate("charge", {"amount": 25})  # allow
    b.record_outcome(success=True, tool_name="charge")
    b.evaluate("charge", {"amount": 200})  # escalate -> auto allow (2 records)
    b.record_outcome(success=True, tool_name="charge")
    yield b
    b.close()


def test_default_format_returns_table(populated_bastion):
    table = populated_bastion.report()
    assert isinstance(table, Table)
    assert table.row_count == populated_bastion.store.count()


def test_markdown_format_returns_str_with_pipes(populated_bastion):
    md = populated_bastion.report(format="markdown")
    assert isinstance(md, str)
    assert md.startswith("# Bastion audit log:")
    assert "| # | Time | Event |" in md
    assert "|---|" in md
    # Each record contributes one row plus title/header rows.
    row_count = sum(1 for line in md.splitlines() if line.startswith("| ") and "---" not in line)
    # header row + N data rows
    assert row_count == populated_bastion.store.count() + 1


def test_html_format_returns_str_with_html_tags(populated_bastion):
    html = populated_bastion.report(format="html")
    assert isinstance(html, str)
    assert "<html" in html
    assert "</html>" in html


def test_json_format_returns_parsable_array(populated_bastion):
    raw = populated_bastion.report(format="json")
    assert isinstance(raw, str)
    parsed = json.loads(raw)
    assert isinstance(parsed, list)
    assert len(parsed) == populated_bastion.store.count()
    for entry in parsed:
        assert "_record_hash" in entry
        assert "_signature" in entry
        # hex strings of fixed length
        assert len(entry["_record_hash"]) == 64
        assert len(entry["_signature"]) == 128


def test_unknown_format_raises(populated_bastion):
    with pytest.raises(ValueError):
        populated_bastion.report(format="csv")


def test_summary_stats_counts_match_chain(populated_bastion):
    stats = populated_bastion.summary_stats()
    assert stats["total"] == populated_bastion.store.count()
    # We have at least one HITL approval in the fixture:
    assert stats["hitl_total"] >= 1
    assert stats["hitl_approved"] >= 1
    assert stats["hitl_denied"] == 0
    assert "code_policy" in stats["by_source"]
    assert "human" in stats["by_source"]


def test_summary_stats_avg_latency_is_numeric(populated_bastion):
    stats = populated_bastion.summary_stats()
    for source, avg in stats["avg_latency_ms_by_source"].items():
        assert isinstance(avg, (int, float))
        assert avg >= 0


def test_summary_stats_handles_empty_chain(tmp_path):
    b = Bastion(
        agent_id="empty",
        db_path=tmp_path / "audit.db",
        keys_dir=tmp_path / "keys",
    )
    stats = b.summary_stats()
    assert stats["total"] == 0
    assert stats["hitl_total"] == 0
    b.close()


def test_html_export_includes_table_content(populated_bastion):
    html = populated_bastion.report(format="html")
    # Tools should appear somewhere in the rendered HTML.
    assert "delete_file" in html
    assert "charge" in html
