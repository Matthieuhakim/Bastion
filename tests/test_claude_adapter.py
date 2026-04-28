"""Tests for the Claude Agent SDK adapter.

Live integration tests (a real Claude agent issuing tool calls) require
ANTHROPIC_API_KEY and are marked @pytest.mark.integration. The unit
tests here exercise the can_use_tool callback and PreToolUse / PostToolUse
hooks against a real Bastion instance with mocked engine outputs.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from claude_agent_sdk import (
    HookMatcher,
    PermissionResultAllow,
    PermissionResultDeny,
)

from bastion import Bastion, policy
from bastion.adapters.claude_agent_sdk import wire


@pytest.fixture
def bastion(tmp_path):
    b = Bastion(
        agent_id="adapter-test",
        policies=[
            policy.deny.tools("delete_file"),
            policy.deny.paths("/etc/*"),
        ],
        db_path=tmp_path / "audit.db",
        keys_dir=tmp_path / "keys",
    )
    yield b
    b.close()


def test_wire_returns_can_use_tool_and_hooks_by_default(bastion):
    wired = wire(bastion)
    assert "can_use_tool" in wired
    assert callable(wired["can_use_tool"])
    assert "hooks" in wired
    assert "PostToolUse" in wired["hooks"]
    assert isinstance(wired["hooks"]["PostToolUse"][0], HookMatcher)


def test_wire_pre_tool_use_mode_omits_can_use_tool(bastion):
    wired = wire(bastion, mode="pre_tool_use_hook")
    assert "can_use_tool" not in wired
    assert "PreToolUse" in wired["hooks"]
    assert "PostToolUse" in wired["hooks"]


def test_wire_rejects_unknown_mode(bastion):
    with pytest.raises(ValueError):
        wire(bastion, mode="bogus")  # type: ignore[arg-type]


def test_can_use_tool_allows_safe_call(bastion):
    wired = wire(bastion)
    callback = wired["can_use_tool"]
    result = asyncio.run(callback("Read", {"path": "/tmp/safe.txt"}, None))
    assert isinstance(result, PermissionResultAllow)


def test_can_use_tool_denies_blocked_call(bastion):
    wired = wire(bastion)
    callback = wired["can_use_tool"]
    result = asyncio.run(callback("delete_file", {"path": "/tmp/x"}, None))
    assert isinstance(result, PermissionResultDeny)
    assert "delete_file" in result.message
    assert result.interrupt is False


def test_can_use_tool_denies_path_match(bastion):
    wired = wire(bastion)
    callback = wired["can_use_tool"]
    result = asyncio.run(callback("Write", {"path": "/etc/passwd"}, None))
    assert isinstance(result, PermissionResultDeny)
    assert "/etc/" in result.message


def test_can_use_tool_writes_audit_record(bastion):
    wired = wire(bastion)
    callback = wired["can_use_tool"]
    asyncio.run(callback("Read", {"path": "/tmp/x"}, None))
    asyncio.run(callback("delete_file", {"path": "/tmp/x"}, None))
    assert bastion.store.count() == 2


def test_pre_tool_use_hook_returns_allow_decision(bastion):
    wired = wire(bastion, mode="pre_tool_use_hook")
    hook = wired["hooks"]["PreToolUse"][0].hooks[0]
    result = asyncio.run(
        hook({"tool_name": "Read", "tool_input": {"path": "/tmp/safe"}}, None, {})
    )
    assert result["hookSpecificOutput"]["permissionDecision"] == "allow"


def test_pre_tool_use_hook_returns_deny_decision(bastion):
    wired = wire(bastion, mode="pre_tool_use_hook")
    hook = wired["hooks"]["PreToolUse"][0].hooks[0]
    result = asyncio.run(
        hook({"tool_name": "delete_file", "tool_input": {}}, None, {})
    )
    assert result["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert "delete_file" in result["hookSpecificOutput"]["permissionDecisionReason"]


def test_post_tool_use_hook_records_outcome(bastion):
    wired = wire(bastion)
    callback = wired["can_use_tool"]
    post_hook = wired["hooks"]["PostToolUse"][0].hooks[0]

    # Decision record
    asyncio.run(callback("Read", {"path": "/tmp/x"}, None))
    decision_count = bastion.store.count()

    # Outcome record
    asyncio.run(
        post_hook(
            {
                "tool_name": "Read",
                "tool_input": {"path": "/tmp/x"},
                "tool_response": {"content": "hello"},
                "tool_use_id": "abc",
            },
            "abc",
            {},
        )
    )
    assert bastion.store.count() == decision_count + 1

    last = bastion.store.latest_record()
    body = json.loads(last.record_json)
    assert body["event"] == "tool_outcome"
    assert body["tool_name"] == "Read"
    assert body["success"] is True
    assert body["output_hash"]


def test_post_tool_use_hook_swallows_exceptions(bastion, monkeypatch):
    """Audit logging failures must not crash the agent loop."""
    wired = wire(bastion)
    post_hook = wired["hooks"]["PostToolUse"][0].hooks[0]

    def boom(**kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(bastion, "record_outcome", boom)

    # Should not raise.
    result = asyncio.run(
        post_hook(
            {
                "tool_name": "Read",
                "tool_input": {},
                "tool_response": "ok",
                "tool_use_id": "x",
            },
            "x",
            {},
        )
    )
    assert result == {}


# --- Live integration test (skipped unless explicitly enabled) ---


@pytest.mark.integration
@pytest.mark.skip(
    reason="Requires ANTHROPIC_API_KEY and a running Claude Agent SDK."
)
def test_live_agent_blocks_denied_tool():
    """Sketch only.

    To run manually: set ANTHROPIC_API_KEY, remove the skip marker, and
    ensure claude-agent-sdk's CLI dependency is installed and reachable.
    """
    pass  # pragma: no cover
