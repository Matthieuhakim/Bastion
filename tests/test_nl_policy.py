"""Tests for NL policies and the LLM judge.

Live LLM tests are marked with @pytest.mark.llm so they can be skipped
in fast runs (`pytest -m 'not llm'`). The non-llm tests cover prompt
construction, response parsing, and engine routing via mocks.
"""

from __future__ import annotations

import json
import os
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from bastion import policy
from bastion.policy.engine import PolicyEngine
from bastion.policy.llm_judge import LLMJudge, _strip_code_fences
from bastion.policy.nl_policy import NLPolicy
from bastion.policy.schema import Decision


def _fake_response(text: str):
    return SimpleNamespace(content=[SimpleNamespace(text=text)])


def _judge_with_response(text: str) -> LLMJudge:
    client = MagicMock()
    client.messages.create.return_value = _fake_response(text)
    return LLMJudge(client=client)


class TestNLPolicy:
    def test_nl_policy_is_marked(self):
        p = policy.nl("don't touch /etc")
        assert isinstance(p, NLPolicy)
        assert getattr(p, "is_nl_policy", False) is True
        assert p.text == "don't touch /etc"

    def test_policy_id_is_stable_for_same_text(self):
        a = policy.nl("rule one")
        b = policy.nl("rule one")
        assert a.policy_id == b.policy_id
        assert a.policy_id.startswith("nl:")

    def test_empty_text_rejected(self):
        with pytest.raises(ValueError):
            policy.nl("")
        with pytest.raises(ValueError):
            policy.nl("   ")

    def test_engine_separates_nl_from_code(self):
        engine = PolicyEngine([
            policy.deny.tools("X"),
            policy.nl("first"),
            policy.escalate.above("amount", 10),
            policy.nl("second"),
        ])
        assert len(engine.code_policies) == 2
        assert len(engine.nl_policies) == 2


class TestPromptAndParse:
    def test_strip_code_fences_with_json_block(self):
        text = '```json\n{"decision": "allow", "reason": "ok", "policy_violated": null}\n```'
        cleaned = _strip_code_fences(text)
        assert cleaned == '{"decision": "allow", "reason": "ok", "policy_violated": null}'

    def test_strip_code_fences_with_bare_block(self):
        text = '```\n{"decision":"deny"}\n```'
        cleaned = _strip_code_fences(text)
        assert cleaned == '{"decision":"deny"}'

    def test_strip_code_fences_passthrough_when_unfenced(self):
        assert _strip_code_fences('{"decision":"allow"}') == '{"decision":"allow"}'

    def test_judge_returns_allow_when_model_says_allow(self):
        judge = _judge_with_response(
            '{"decision":"allow","reason":"safe","policy_violated":null}'
        )
        d = judge.evaluate([policy.nl("be safe")], "Read", {"path": "/tmp/x"})
        assert d.outcome == "allow"
        assert d.source == "llm_judge"
        assert "safe" in d.reason

    def test_judge_returns_deny_with_matching_policy_id(self):
        nl_p = policy.nl("Never access /etc")
        judge = _judge_with_response(
            '{"decision":"deny","reason":"violates /etc rule","policy_violated":"Never access /etc"}'
        )
        d = judge.evaluate([nl_p], "Read", {"path": "/etc/passwd"})
        assert d.outcome == "deny"
        assert d.policy_id == nl_p.policy_id

    def test_judge_handles_code_fenced_response(self):
        judge = _judge_with_response(
            '```json\n{"decision":"escalate","reason":"borderline","policy_violated":null}\n```'
        )
        d = judge.evaluate([policy.nl("rule")], "X", {})
        assert d.outcome == "escalate"

    def test_judge_escalates_on_invalid_outcome(self):
        judge = _judge_with_response('{"decision":"banana","reason":"x"}')
        d = judge.evaluate([policy.nl("rule")], "X", {})
        assert d.outcome == "escalate"
        assert d.policy_id == "judge.invalid_outcome"

    def test_judge_escalates_on_non_json(self):
        judge = _judge_with_response("not json at all")
        d = judge.evaluate([policy.nl("rule")], "X", {})
        assert d.outcome == "escalate"
        assert d.policy_id == "judge.parse_error"

    def test_judge_escalates_on_api_error(self):
        client = MagicMock()
        client.messages.create.side_effect = RuntimeError("boom")
        judge = LLMJudge(client=client)
        d = judge.evaluate([policy.nl("rule")], "X", {})
        assert d.outcome == "escalate"
        assert d.policy_id == "judge.unavailable"

    def test_judge_skips_call_with_no_nl_policies(self):
        client = MagicMock()
        judge = LLMJudge(client=client)
        d = judge.evaluate([], "X", {})
        assert d.outcome == "allow"
        client.messages.create.assert_not_called()


class TestEngineWithJudge:
    def test_engine_calls_judge_when_only_nl_policies(self):
        nl_p = policy.nl("Don't touch secrets")
        judge = _judge_with_response(
            '{"decision":"deny","reason":"contains secrets","policy_violated":"Don\'t touch secrets"}'
        )
        engine = PolicyEngine([nl_p], judge=judge.evaluate)
        d = engine.evaluate("Read", {"path": "/etc/secrets"})
        assert d.outcome == "deny"
        assert d.source == "llm_judge"

    def test_engine_skips_judge_when_code_denies(self):
        client = MagicMock()
        judge = LLMJudge(client=client)
        engine = PolicyEngine(
            [policy.deny.tools("Bad"), policy.nl("rule")],
            judge=judge.evaluate,
        )
        d = engine.evaluate("Bad", {})
        assert d.outcome == "deny"
        client.messages.create.assert_not_called()

    def test_engine_calls_judge_for_nl_after_code_allows(self):
        nl_p = policy.nl("rule")
        judge = _judge_with_response(
            '{"decision":"allow","reason":"ok","policy_violated":null}'
        )
        engine = PolicyEngine(
            [policy.deny.tools("OtherTool"), nl_p],
            judge=judge.evaluate,
        )
        d = engine.evaluate("Read", {"path": "/tmp/x"})
        assert d.outcome == "allow"
        assert d.source == "llm_judge"


# ----- Live LLM tests (skip without ANTHROPIC_API_KEY) -----

_HAS_KEY = bool(os.environ.get("ANTHROPIC_API_KEY"))
_skip_no_key = pytest.mark.skipif(not _HAS_KEY, reason="ANTHROPIC_API_KEY not set")


@pytest.mark.llm
@_skip_no_key
def test_live_clear_violation_denies():
    judge = LLMJudge()
    p = policy.nl("Never read files under /etc")
    decisions = [judge.evaluate([p], "Read", {"path": "/etc/passwd"}) for _ in range(3)]
    outcomes = [d.outcome for d in decisions]
    assert outcomes.count("deny") >= 2, f"expected deny on clear violation, got {outcomes}"


@pytest.mark.llm
@_skip_no_key
def test_live_clearly_safe_allows():
    judge = LLMJudge()
    p = policy.nl("Never read files under /etc")
    d = judge.evaluate([p], "Read", {"path": "/tmp/log.txt"})
    assert d.outcome == "allow", f"expected allow on safe call, got {d.outcome} ({d.reason})"


@pytest.mark.llm
@_skip_no_key
def test_live_ambiguous_does_not_crash():
    judge = LLMJudge()
    p = policy.nl("Don't access files containing personal information")
    d = judge.evaluate([p], "Read", {"path": "/tmp/notes.txt"})
    assert d.outcome in ("allow", "deny", "escalate")
