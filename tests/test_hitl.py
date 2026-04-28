"""Tests for the CLI HITL handler."""

from __future__ import annotations

import builtins
import io
import time
from unittest.mock import patch

import pytest
from rich.console import Console

from bastion.hitl.cli_prompt import CLIPromptHandler
from bastion.policy.engine import PolicyEngine
from bastion.policy.schema import Decision
from bastion import policy


def _silent_console() -> Console:
    return Console(file=io.StringIO(), force_terminal=False, width=80)


def _esc_decision() -> Decision:
    return Decision(
        outcome="escalate",
        source="code_policy",
        policy_id="escalate.above:amount:30",
        reason="amount 200 exceeds threshold 30",
    )


def test_approve_returns_allow_with_human_source():
    handler = CLIPromptHandler(timeout=2.0, console=_silent_console())
    with patch.object(builtins, "input", return_value="a"):
        result = handler.request_approval(
            _esc_decision(), "charge_card", {"amount": 200, "currency": "USD"}
        )
    assert result.outcome == "allow"
    assert result.source == "human"
    assert result.policy_id == "human.approved"


def test_deny_returns_deny_with_human_source():
    handler = CLIPromptHandler(timeout=2.0, console=_silent_console())
    with patch.object(builtins, "input", return_value="d"):
        result = handler.request_approval(
            _esc_decision(), "charge_card", {"amount": 200}
        )
    assert result.outcome == "deny"
    assert result.source == "human"
    assert result.policy_id == "human.denied"


@pytest.mark.parametrize("response,expected", [
    ("a", "allow"),
    ("A", "allow"),
    ("approve", "allow"),
    ("yes", "allow"),
    ("y", "allow"),
    ("d", "deny"),
    ("deny", "deny"),
    ("no", "deny"),
    ("n", "deny"),
])
def test_response_normalization(response, expected):
    handler = CLIPromptHandler(timeout=2.0, console=_silent_console())
    with patch.object(builtins, "input", return_value=response):
        result = handler.request_approval(_esc_decision(), "X", {})
    assert result.outcome == expected


def test_invalid_response_denies():
    handler = CLIPromptHandler(timeout=2.0, console=_silent_console())
    with patch.object(builtins, "input", return_value="maybe"):
        result = handler.request_approval(_esc_decision(), "X", {})
    assert result.outcome == "deny"
    assert result.policy_id == "human.invalid"


def test_timeout_returns_deny():
    """A blocking input that never returns triggers a fail-safe deny."""
    def _hang(prompt=""):
        time.sleep(10)
        return "a"

    handler = CLIPromptHandler(timeout=0.4, console=_silent_console())
    with patch.object(builtins, "input", side_effect=_hang):
        start = time.perf_counter()
        result = handler.request_approval(_esc_decision(), "X", {})
        elapsed = time.perf_counter() - start

    assert result.outcome == "deny"
    assert result.policy_id == "human.timeout"
    assert elapsed < 1.5, f"timeout took too long: {elapsed:.2f}s"


def test_handler_is_callable_for_engine_wiring():
    """The handler should be usable directly as the engine's `hitl` callable."""
    handler = CLIPromptHandler(timeout=2.0, console=_silent_console())
    with patch.object(builtins, "input", return_value="a"):
        engine = PolicyEngine(
            [policy.escalate.above("amount", 30)],
            hitl=handler,
        )
        result = engine.evaluate("charge", {"amount": 200})

    assert result.outcome == "allow"
    assert result.source == "human"


def test_engine_skips_hitl_on_deny():
    """Deny outcomes should not trigger HITL prompts."""
    handler_called = {"n": 0}

    def fake_hitl(decision, tool_name, input_data):
        handler_called["n"] += 1
        return Decision(
            outcome="allow", source="human", policy_id="human", reason="ok"
        )

    engine = PolicyEngine([policy.deny.tools("X")], hitl=fake_hitl)
    result = engine.evaluate("X", {})
    assert result.outcome == "deny"
    assert handler_called["n"] == 0


def test_huge_input_is_truncated_in_prompt():
    """Confirm rendering survives a giant input dict."""
    handler = CLIPromptHandler(timeout=2.0, console=_silent_console())
    huge = {"data": "x" * 10000}
    with patch.object(builtins, "input", return_value="d"):
        result = handler.request_approval(_esc_decision(), "X", huge)
    assert result.outcome == "deny"
