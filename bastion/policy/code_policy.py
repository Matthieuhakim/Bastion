"""Code-policy DSL: deny/escalate over tool names, paths, thresholds, and functions."""

from __future__ import annotations

import fnmatch
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from bastion.policy.schema import Decision, DecisionOutcome, Policy

PolicyFn = Callable[[str, dict[str, Any]], bool]


def _walk_strings(obj: Any) -> Iterable[str]:
    """Yield every string value found anywhere in obj (recurses into dicts/lists)."""
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _walk_strings(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from _walk_strings(v)


def _allow(policy_id: str) -> Decision:
    return Decision(
        outcome="allow",
        source="code_policy",
        policy_id=policy_id,
        reason="not matched",
    )


class ToolNamePolicy(Policy):
    def __init__(self, names: tuple[str, ...], outcome: DecisionOutcome) -> None:
        self.names = set(names)
        self.outcome: DecisionOutcome = outcome
        self.policy_id = f"{outcome}.tools:{'|'.join(sorted(self.names))}"

    def evaluate(self, tool_name: str, input_data: dict) -> Decision:
        if tool_name in self.names:
            return Decision(
                outcome=self.outcome,
                source="code_policy",
                policy_id=self.policy_id,
                reason=f"tool '{tool_name}' matches policy",
            )
        return _allow(self.policy_id)


class PathPolicy(Policy):
    """Matches if any string in input_data fnmatches any pattern.

    Patterns starting with '~' are expanded against the user's home. The
    raw pattern is also tried so cross-platform '~' literals still match.
    """

    def __init__(self, patterns: tuple[str, ...], outcome: DecisionOutcome) -> None:
        self.patterns = patterns
        self.outcome: DecisionOutcome = outcome
        self.policy_id = f"{outcome}.paths:{'|'.join(patterns)}"
        self._expanded = [
            str(Path(p).expanduser()) if p.startswith("~") else p for p in patterns
        ]

    def evaluate(self, tool_name: str, input_data: dict) -> Decision:
        for value in _walk_strings(input_data):
            for raw, expanded in zip(self.patterns, self._expanded, strict=True):
                if fnmatch.fnmatch(value, raw) or (
                    expanded != raw and fnmatch.fnmatch(value, expanded)
                ):
                    return Decision(
                        outcome=self.outcome,
                        source="code_policy",
                        policy_id=self.policy_id,
                        reason=f"path '{value}' matches pattern '{raw}'",
                    )
        return _allow(self.policy_id)


class ThresholdPolicy(Policy):
    """Triggers when input_data[field] is numeric and strictly greater than threshold."""

    def __init__(
        self, field: str, threshold: float, outcome: DecisionOutcome
    ) -> None:
        self.field = field
        self.threshold = threshold
        self.outcome: DecisionOutcome = outcome
        self.policy_id = f"{outcome}.above:{field}:{threshold}"

    def evaluate(self, tool_name: str, input_data: dict) -> Decision:
        value = input_data.get(self.field)
        if isinstance(value, bool):
            value = None
        if isinstance(value, (int, float)) and value > self.threshold:
            return Decision(
                outcome=self.outcome,
                source="code_policy",
                policy_id=self.policy_id,
                reason=f"{self.field} {value} exceeds threshold {self.threshold}",
            )
        return _allow(self.policy_id)


class FunctionPolicy(Policy):
    """Wraps a user function (tool_name, input_data) -> bool into a Policy."""

    def __init__(self, func: PolicyFn, outcome: DecisionOutcome) -> None:
        self.func = func
        self.outcome: DecisionOutcome = outcome
        name = getattr(func, "__name__", "anonymous")
        self.policy_id = f"{outcome}.func:{name}"

    def evaluate(self, tool_name: str, input_data: dict) -> Decision:
        if self.func(tool_name, input_data):
            return Decision(
                outcome=self.outcome,
                source="code_policy",
                policy_id=self.policy_id,
                reason=f"{self.func.__name__} returned True",
            )
        return _allow(self.policy_id)


class _OutcomeBuilder:
    """The `policy.deny` / `policy.escalate` namespace.

    Supports both factory calls (`.tools()`, `.paths()`, `.above()`)
    and decorator usage (`@policy.deny def my_check(...): ...`).
    """

    def __init__(self, outcome: DecisionOutcome) -> None:
        self._outcome: DecisionOutcome = outcome

    def tools(self, *names: str) -> Policy:
        if not names:
            raise ValueError("tools(...) requires at least one tool name")
        return ToolNamePolicy(names, self._outcome)

    def paths(self, *patterns: str) -> Policy:
        if not patterns:
            raise ValueError("paths(...) requires at least one pattern")
        return PathPolicy(patterns, self._outcome)

    def above(self, field: str, threshold: float) -> Policy:
        return ThresholdPolicy(field, threshold, self._outcome)

    def __call__(self, func: PolicyFn) -> Policy:
        return FunctionPolicy(func, self._outcome)


deny = _OutcomeBuilder("deny")
escalate = _OutcomeBuilder("escalate")
