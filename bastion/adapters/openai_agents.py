"""OpenAI Agents SDK adapter (sketch).

Sketch demonstrating the framework-agnostic core. Full integration is
future work. The OpenAI Agents SDK (`openai-agents` on PyPI) supports
input/output guardrails per agent and per tool. This module shows two
shapes you can plug Bastion into without taking a hard runtime
dependency on the SDK itself.

Usage with the OpenAI Agents SDK (illustrative):

    from agents import Agent, function_tool
    from bastion import Bastion, policy
    from bastion.adapters.openai_agents import bastion_guard

    bastion = Bastion(agent_id="oai-demo", policies=[policy.deny.tools("delete_file")])

    @bastion_guard(bastion, tool_name="delete_file")
    @function_tool
    def delete_file(path: str) -> str:
        os.remove(path)
        return f"deleted {path}"

    agent = Agent(name="cleaner", tools=[delete_file])

`bastion_guard` returns a decorator that, before invoking the wrapped
tool function, runs `bastion.evaluate(tool_name, kwargs)` and either
proceeds (allow) or raises a PermissionError (deny). After a successful
call it appends a tool_outcome record.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Callable
from functools import wraps
from typing import Any, TypeVar

from bastion.audit.chain import hash_input
from bastion.sdk import Bastion

F = TypeVar("F", bound=Callable[..., Any])


class BastionPermissionError(PermissionError):
    """Raised when Bastion denies a tool call."""

    def __init__(self, decision: Any) -> None:
        super().__init__(
            f"Bastion denied this tool call (policy: {decision.policy_id}). "
            f"Reason: {decision.reason}"
        )
        self.decision = decision


def bastion_guard(bastion: Bastion, tool_name: str | None = None) -> Callable[[F], F]:
    """Decorator that gates a function-tool through Bastion.

    Wraps either an async or sync tool. The tool's keyword args are passed
    as `input_data` to bastion.evaluate. On allow the tool runs and a
    tool_outcome is recorded; on deny BastionPermissionError is raised.
    """

    def decorate(fn: F) -> F:
        resolved_name = tool_name or getattr(fn, "__name__", "tool")

        if inspect.iscoroutinefunction(fn):
            @wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                input_data = _input_for(args, kwargs)
                decision = await asyncio.to_thread(
                    bastion.evaluate, resolved_name, input_data
                )
                if decision.outcome != "allow":
                    raise BastionPermissionError(decision)
                try:
                    result = await fn(*args, **kwargs)
                except Exception as e:
                    bastion.record_outcome(
                        success=False, error=str(e), tool_name=resolved_name
                    )
                    raise
                bastion.record_outcome(
                    success=True,
                    output_hash=hash_input(result),
                    tool_name=resolved_name,
                )
                return result

            return async_wrapper  # type: ignore[return-value]

        @wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            input_data = _input_for(args, kwargs)
            decision = bastion.evaluate(resolved_name, input_data)
            if decision.outcome != "allow":
                raise BastionPermissionError(decision)
            try:
                result = fn(*args, **kwargs)
            except Exception as e:
                bastion.record_outcome(
                    success=False, error=str(e), tool_name=resolved_name
                )
                raise
            bastion.record_outcome(
                success=True,
                output_hash=hash_input(result),
                tool_name=resolved_name,
            )
            return result

        return sync_wrapper  # type: ignore[return-value]

    return decorate


def _input_for(args: tuple, kwargs: dict[str, Any]) -> dict[str, Any]:
    # function_tool decorators usually call with kwargs; treat positional
    # args as `args` if any are present.
    if not args:
        return dict(kwargs)
    data = dict(kwargs)
    data.setdefault("args", list(args))
    return data
