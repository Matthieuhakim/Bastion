"""Tests for the code-policy DSL primitives."""

from __future__ import annotations

import pytest

from bastion import policy
from bastion.policy.code_policy import (
    FunctionPolicy,
    PathPolicy,
    ThresholdPolicy,
    ToolNamePolicy,
)


class TestToolNamePolicy:
    def test_denies_matching_tool(self):
        p = policy.deny.tools("Delete", "DropTable")
        d = p.evaluate("Delete", {})
        assert d.outcome == "deny"
        assert d.source == "code_policy"
        assert "Delete" in d.reason

    def test_allows_non_matching_tool(self):
        p = policy.deny.tools("Delete")
        d = p.evaluate("Read", {})
        assert d.outcome == "allow"

    def test_escalate_variant(self):
        p = policy.escalate.tools("charge_card")
        assert p.evaluate("charge_card", {"amount": 5}).outcome == "escalate"

    def test_policy_id_format(self):
        p = policy.deny.tools("B", "A")
        assert p.policy_id == "deny.tools:A|B"

    def test_empty_tools_raises(self):
        with pytest.raises(ValueError):
            policy.deny.tools()


class TestPathPolicy:
    def test_denies_path_in_input(self):
        p = policy.deny.paths("/etc/*")
        d = p.evaluate("Write", {"path": "/etc/passwd"})
        assert d.outcome == "deny"
        assert "/etc/passwd" in d.reason

    def test_allows_safe_path(self):
        p = policy.deny.paths("/etc/*")
        d = p.evaluate("Write", {"path": "/tmp/x"})
        assert d.outcome == "allow"

    def test_matches_path_under_any_field_name(self):
        p = policy.deny.paths("*.env")
        d = p.evaluate("Read", {"target_file": ".env"})
        assert d.outcome == "deny"

    def test_matches_paths_in_nested_structures(self):
        p = policy.deny.paths("/etc/*")
        d = p.evaluate("Bash", {"args": ["cat", "/etc/passwd"]})
        assert d.outcome == "deny"

    def test_home_expansion(self):
        p = policy.deny.paths("~/.ssh/*")
        d = p.evaluate("Read", {"path": "~/.ssh/id_rsa"})
        assert d.outcome == "deny"


class TestThresholdPolicy:
    def test_escalate_above_threshold(self):
        p = policy.escalate.above("amount", 30)
        assert p.evaluate("charge", {"amount": 50}).outcome == "escalate"

    def test_allow_at_or_below_threshold(self):
        p = policy.escalate.above("amount", 30)
        assert p.evaluate("charge", {"amount": 30}).outcome == "allow"
        assert p.evaluate("charge", {"amount": 20}).outcome == "allow"

    def test_deny_above_high_threshold(self):
        p = policy.deny.above("amount", 1000)
        assert p.evaluate("charge", {"amount": 5000}).outcome == "deny"

    def test_handles_missing_field(self):
        p = policy.deny.above("amount", 100)
        assert p.evaluate("charge", {}).outcome == "allow"

    def test_ignores_non_numeric(self):
        p = policy.deny.above("amount", 100)
        assert p.evaluate("charge", {"amount": "lots"}).outcome == "allow"

    def test_ignores_booleans(self):
        # bool is a subclass of int in Python; policy must reject it.
        p = policy.deny.above("amount", 0)
        assert p.evaluate("charge", {"amount": True}).outcome == "allow"

    def test_supports_floats(self):
        p = policy.escalate.above("amount", 30.5)
        assert p.evaluate("charge", {"amount": 30.6}).outcome == "escalate"
        assert p.evaluate("charge", {"amount": 30.4}).outcome == "allow"


class TestFunctionPolicy:
    def test_decorator_form(self):
        @policy.deny
        def block_destructive_bash(tool_name, input_data):
            return tool_name == "Bash" and "rm -rf" in input_data.get("command", "")

        assert isinstance(block_destructive_bash, FunctionPolicy)
        assert (
            block_destructive_bash.evaluate("Bash", {"command": "rm -rf /"}).outcome
            == "deny"
        )
        assert (
            block_destructive_bash.evaluate("Bash", {"command": "ls"}).outcome
            == "allow"
        )

    def test_function_policy_id_uses_function_name(self):
        @policy.escalate
        def needs_review(tn, ip):
            return True

        assert needs_review.policy_id == "escalate.func:needs_review"
