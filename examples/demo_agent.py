"""Demo agent: 4 in-process MCP tools wrapped by a Bastion policy stack.

Tools (exposed via an SDK MCP server):
  - read_file(path): read a file under the demo sandbox
  - write_file(path, content): write a file under the sandbox
  - delete_file(path): delete a file (mostly denied by policy)
  - charge_card(amount, currency): fake Stripe-style payment

Policies:
  - deny tools matching `delete_file` (any prefix from the MCP server)
  - deny paths under /etc/*, ~/.ssh/*, *.env
  - deny charges over $1000
  - escalate charges over $30 (HITL prompt)
  - NL: don't access files containing personal information

The demo sets BASTION_HOME so the store and keys live under examples/.bastion/.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path
from typing import Any

from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, tool

from bastion import Bastion, policy
from bastion.adapters.claude_agent_sdk import wire

DEMO_SERVER_NAME = "bastion_demo"
DEMO_DIR = Path(os.environ.get("BASTION_DEMO_DIR", "/tmp/bastion-demo")).resolve()
AGENT_ID = "demo-agent"


def _safe_resolve(raw: str) -> Path:
    """Resolve raw to an absolute path; abort if it escapes DEMO_DIR."""
    p = Path(raw).expanduser().resolve()
    if DEMO_DIR not in p.parents and p != DEMO_DIR:
        raise ValueError(f"path {p} is outside demo sandbox {DEMO_DIR}")
    return p


def _ok(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}]}


def _err(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": f"ERROR: {text}"}], "isError": True}


@tool("read_file", "Read a UTF-8 text file under the demo sandbox", {"path": str})
async def read_file(args: dict[str, Any]) -> dict[str, Any]:
    try:
        path = _safe_resolve(args["path"])
        if not path.exists():
            return _err(f"file not found: {path}")
        return _ok(path.read_text(encoding="utf-8"))
    except Exception as e:
        return _err(str(e))


@tool(
    "write_file",
    "Write content to a file under the demo sandbox",
    {"path": str, "content": str},
)
async def write_file(args: dict[str, Any]) -> dict[str, Any]:
    try:
        path = _safe_resolve(args["path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(args["content"], encoding="utf-8")
        return _ok(f"wrote {len(args['content'])} chars to {path}")
    except Exception as e:
        return _err(str(e))


@tool("delete_file", "Delete a file under the demo sandbox", {"path": str})
async def delete_file(args: dict[str, Any]) -> dict[str, Any]:
    try:
        path = _safe_resolve(args["path"])
        if not path.exists():
            return _err(f"file not found: {path}")
        path.unlink()
        return _ok(f"deleted {path}")
    except Exception as e:
        return _err(str(e))


@tool(
    "charge_card",
    "Charge a credit card. Returns a fake transaction id.",
    {"amount": float, "currency": str},
)
async def charge_card(args: dict[str, Any]) -> dict[str, Any]:
    txn_id = "ch_" + secrets.token_hex(8)
    return _ok(
        f"charged {args['amount']:.2f} {args['currency'].upper()} (txn {txn_id})"
    )


def _mcp_name(local_name: str) -> str:
    """Prefix a local tool name with the MCP server prefix Claude actually sees."""
    return f"mcp__{DEMO_SERVER_NAME}__{local_name}"


def make_demo_policies() -> list[Any]:
    """Policy stack used by the demo. Order matters: deny then escalate."""
    return [
        policy.deny.tools("delete_file", _mcp_name("delete_file")),
        policy.deny.paths("/etc/*", "~/.ssh/*", "*.env"),
        policy.deny.above("amount", 1000),
        policy.escalate.above("amount", 30),
        policy.nl(
            "Don't access files containing personal information like SSNs, "
            "passwords, or financial records."
        ),
    ]


def make_bastion(agent_id: str = AGENT_ID, policies: list[Any] | None = None) -> Bastion:
    return Bastion(
        agent_id=agent_id,
        policies=policies if policies is not None else make_demo_policies(),
    )


def make_options(bastion: Bastion) -> ClaudeAgentOptions:
    server = create_sdk_mcp_server(
        name=DEMO_SERVER_NAME,
        version="1.0.0",
        tools=[read_file, write_file, delete_file, charge_card],
    )

    allowed = [_mcp_name(n) for n in ("read_file", "write_file", "delete_file", "charge_card")]

    return ClaudeAgentOptions(
        mcp_servers={DEMO_SERVER_NAME: server},
        # Disable ALL built-in tools so the agent can only call our 4 MCP
        # tools. Without this, Claude calls built-ins like ToolSearch first,
        # and each one passes through the NL judge which (correctly but
        # unhelpfully) escalates ambiguous internal queries.
        tools=[],
        allowed_tools=allowed,
        system_prompt=(
            "You are a helpful agent for the Bastion demo. You have exactly "
            "four MCP tools: read_file, write_file, delete_file, and "
            "charge_card. When the user asks you to do something, immediately "
            "call the single most appropriate tool with the literal arguments "
            "from the prompt. Do not search for tools, do not call anything "
            "else first, do not explain. After the tool returns, summarize "
            "the result in one sentence."
        ),
        max_turns=3,
        # Use the PreToolUse hook gate. The Claude Agent SDK's can_use_tool
        # callback requires streaming-mode prompts (AsyncIterable), which
        # the simple query() loop in run_demo.py doesn't use. The
        # PreToolUse hook works with both modes and is functionally
        # equivalent for permission gating.
        **wire(bastion, mode="pre_tool_use_hook"),
    )


def setup_demo_dir() -> None:
    """Populate /tmp/bastion-demo with a couple of files the agent can read."""
    DEMO_DIR.mkdir(parents=True, exist_ok=True)
    (DEMO_DIR / "notes.txt").write_text(
        "Welcome to the Bastion demo.\n"
        "This file contains harmless notes.\n",
        encoding="utf-8",
    )
    (DEMO_DIR / "ssn_records.txt").write_text(
        "John Doe SSN: 123-45-6789\n"
        "Jane Smith SSN: 987-65-4321\n"
        "(synthetic records for the NL judge demo)\n",
        encoding="utf-8",
    )
