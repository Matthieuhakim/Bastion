"""Adapter to plug Bastion into Anthropic's Claude Agent SDK.

Usage:

    from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
    from bastion import Bastion, policy
    from bastion.adapters.claude_agent_sdk import wire

    bastion = Bastion(agent_id="demo", policies=[policy.deny.tools("Bash")])

    options = ClaudeAgentOptions(
        allowed_tools=["Bash", "Read", "Write"],
        **wire(bastion),
    )

`wire(bastion)` returns a dict with `can_use_tool` and `hooks` set.

If you encounter the known issue where `can_use_tool` doesn't fire in
some CLI versions, pass `mode="pre_tool_use_hook"` and Bastion will
gate via a PreToolUse hook with permissionDecision instead.
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from claude_agent_sdk import (
    HookContext,
    HookMatcher,
    PermissionResultAllow,
    PermissionResultDeny,
    PostToolUseHookInput,
    PreToolUseHookInput,
    ToolPermissionContext,
)

from bastion.audit.chain import hash_input
from bastion.sdk import Bastion

WireMode = Literal["can_use_tool", "pre_tool_use_hook"]


def wire(bastion: Bastion, mode: WireMode = "can_use_tool") -> dict[str, Any]:
    """Build a partial ClaudeAgentOptions kwargs dict that routes tool calls
    through Bastion for permission and outcome auditing.

    `mode` selects the permission gate:
      - "can_use_tool" (default): use the can_use_tool callback. Per-call,
         supports any tool, returns PermissionResultAllow/Deny.
      - "pre_tool_use_hook": fall back to a PreToolUse hook returning
         permissionDecision. Use this if the CLI version drops can_use_tool.

    A PostToolUse hook is always wired so successful tool calls are
    recorded as tool_outcome records linked to the prior decision.
    """
    if mode not in ("can_use_tool", "pre_tool_use_hook"):
        raise ValueError(f"unknown wire mode: {mode!r}")

    post_tool_hook = _make_post_tool_use_hook(bastion)
    hooks: dict[str, list[HookMatcher]] = {
        "PostToolUse": [HookMatcher(matcher=None, hooks=[post_tool_hook])],
    }

    if mode == "pre_tool_use_hook":
        hooks["PreToolUse"] = [
            HookMatcher(matcher=None, hooks=[_make_pre_tool_use_hook(bastion)])
        ]
        return {"hooks": hooks}

    return {
        "can_use_tool": _make_can_use_tool(bastion),
        "hooks": hooks,
    }


def _make_can_use_tool(bastion: Bastion):
    async def can_use_tool(
        tool_name: str,
        input_data: dict[str, Any],
        context: ToolPermissionContext,
    ) -> PermissionResultAllow | PermissionResultDeny:
        decision = await asyncio.to_thread(bastion.evaluate, tool_name, input_data)
        if decision.outcome == "allow":
            return PermissionResultAllow()
        return PermissionResultDeny(
            message=_deny_message(decision),
            interrupt=False,
        )

    return can_use_tool


def _make_pre_tool_use_hook(bastion: Bastion):
    async def pre_tool_use_hook(
        input_data: PreToolUseHookInput,
        tool_use_id: str | None,
        context: HookContext,
    ) -> dict[str, Any]:
        tool_name = input_data["tool_name"]
        tool_input = input_data["tool_input"]
        decision = await asyncio.to_thread(bastion.evaluate, tool_name, tool_input)

        if decision.outcome == "allow":
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "permissionDecisionReason": decision.reason,
                }
            }

        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": _deny_message(decision),
            }
        }

    return pre_tool_use_hook


def _make_post_tool_use_hook(bastion: Bastion):
    async def post_tool_use_hook(
        input_data: PostToolUseHookInput,
        tool_use_id: str | None,
        context: HookContext,
    ) -> dict[str, Any]:
        try:
            tool_name = input_data.get("tool_name")
            tool_response = input_data.get("tool_response")
            output_hash = (
                hash_input(tool_response) if tool_response is not None else None
            )
            await asyncio.to_thread(
                bastion.record_outcome,
                success=True,
                output_hash=output_hash,
                tool_name=tool_name,
            )
        except Exception:
            # Audit failures must not crash the agent. Best-effort.
            pass
        return {}

    return post_tool_use_hook


def _deny_message(decision: Any) -> str:
    return (
        f"Bastion denied this tool call (policy: {decision.policy_id}). "
        f"Reason: {decision.reason}"
    )
