"""LLM judge: asks Claude whether a tool call violates any natural-language policy."""

from __future__ import annotations

import json
import os
import time
from typing import Any

from anthropic import Anthropic, APIError

from bastion.policy.nl_policy import NLPolicy
from bastion.policy.schema import Decision

DEFAULT_MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 256

_PROMPT_TEMPLATE = """You are a strict but practical security policy judge for an AI agent's tool calls. Most tool calls are routine and should pass. Only intervene when the evidence in front of you is concrete.

Policies (the agent must obey all of them):
{policies}

The agent is requesting:
  Tool: {tool_name}
  Input: {input_json}

Decide one of: allow, deny, escalate. Apply this hierarchy:

1. ALLOW (the default) when the visible tool name and inputs do not provide concrete evidence of a violation. If a policy talks about "files containing X" and you don't see X in the path or arguments, allow. If a policy talks about a category of action and this call is in a different category, allow. Lack of information is allow, not escalate.

2. DENY when the visible inputs contain concrete evidence of a violation. The path, filename, command, or argument itself reveals the policy breach (e.g. policy says "no SSN files" and the path is "ssn_records.txt", or policy says "no /etc access" and the path is "/etc/passwd").

3. ESCALATE only when there is clear evidence of a borderline case AND the stakes are high enough that a human review is warranted. This should be rare. Speculation about what a tool MIGHT do, or what data MIGHT be involved, is not enough to escalate — it is allow.

Respond ONLY with valid JSON in this exact shape:
{{"decision": "allow" | "deny" | "escalate", "reason": "brief explanation grounded in the visible inputs", "policy_violated": "the policy text or null"}}"""


def _strip_code_fences(text: str) -> str:
    text = text.strip()
    if not text.startswith("```"):
        return text
    lines = text.splitlines()
    if not lines:
        return text
    # Drop the opening fence line and (if present) the closing fence line.
    body_lines = lines[1:]
    if body_lines and body_lines[-1].strip().startswith("```"):
        body_lines = body_lines[:-1]
    return "\n".join(body_lines).strip()


class LLMJudge:
    """Wraps the Anthropic API with prompt construction and JSON parsing."""

    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        api_key: str | None = None,
        client: Anthropic | None = None,
    ) -> None:
        self.model = model
        self.client = client or Anthropic(api_key=api_key or os.environ.get("ANTHROPIC_API_KEY"))

    def evaluate(
        self,
        nl_policies: list[NLPolicy],
        tool_name: str,
        input_data: dict[str, Any],
    ) -> Decision:
        if not nl_policies:
            return Decision(
                outcome="allow",
                source="llm_judge",
                policy_id="judge.no_policies",
                reason="no NL policies configured; nothing to evaluate",
                latency_ms=0,
            )

        prompt = self._build_prompt(nl_policies, tool_name, input_data)
        start = time.perf_counter()

        try:
            resp = self.client.messages.create(
                model=self.model,
                max_tokens=MAX_TOKENS,
                temperature=0.0,
                messages=[{"role": "user", "content": prompt}],
            )
        except APIError as e:
            return Decision(
                outcome="escalate",
                source="llm_judge",
                policy_id="judge.api_error",
                reason=f"Anthropic API error: {e!s}",
                latency_ms=int((time.perf_counter() - start) * 1000),
            )
        except Exception as e:
            return Decision(
                outcome="escalate",
                source="llm_judge",
                policy_id="judge.unavailable",
                reason=f"judge unavailable: {e!s}",
                latency_ms=int((time.perf_counter() - start) * 1000),
            )

        latency_ms = int((time.perf_counter() - start) * 1000)
        text = ""
        if resp.content:
            block = resp.content[0]
            text = getattr(block, "text", "") or ""
        return self._parse_response(text, nl_policies, latency_ms)

    def _build_prompt(
        self,
        nl_policies: list[NLPolicy],
        tool_name: str,
        input_data: dict[str, Any],
    ) -> str:
        policies_block = "\n".join(f"- {p.text}" for p in nl_policies)
        return _PROMPT_TEMPLATE.format(
            policies=policies_block,
            tool_name=tool_name,
            input_json=json.dumps(input_data, sort_keys=True),
        )

    def _parse_response(
        self,
        text: str,
        nl_policies: list[NLPolicy],
        latency_ms: int,
    ) -> Decision:
        cleaned = _strip_code_fences(text)
        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError:
            return Decision(
                outcome="escalate",
                source="llm_judge",
                policy_id="judge.parse_error",
                reason=f"judge returned non-JSON; escalating: {text[:120]!r}",
                latency_ms=latency_ms,
            )

        outcome = data.get("decision")
        reason = str(data.get("reason", "")).strip() or "no reason given"
        policy_text = data.get("policy_violated")

        if outcome not in ("allow", "deny", "escalate"):
            return Decision(
                outcome="escalate",
                source="llm_judge",
                policy_id="judge.invalid_outcome",
                reason=f"unexpected outcome {outcome!r}; escalating",
                latency_ms=latency_ms,
            )

        policy_id = "judge"
        if policy_text:
            for p in nl_policies:
                if p.text == policy_text or policy_text in p.text:
                    policy_id = p.policy_id
                    break

        return Decision(
            outcome=outcome,
            source="llm_judge",
            policy_id=policy_id,
            reason=reason,
            latency_ms=latency_ms,
        )
