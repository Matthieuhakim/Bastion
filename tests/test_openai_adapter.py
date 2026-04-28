"""Tests for the OpenAI Agents SDK adapter sketch."""

from __future__ import annotations

import asyncio

import pytest

from bastion import Bastion, policy
from bastion.adapters.openai_agents import BastionPermissionError, bastion_guard


@pytest.fixture
def bastion(tmp_path):
    b = Bastion(
        agent_id="oai-test",
        policies=[
            policy.deny.tools("delete_file"),
            policy.escalate.above("amount", 30),
        ],
        db_path=tmp_path / "audit.db",
        keys_dir=tmp_path / "keys",
    )
    yield b
    b.close()


def test_module_imports():
    import bastion.adapters.openai_agents as m

    assert hasattr(m, "bastion_guard")
    assert hasattr(m, "BastionPermissionError")


def test_sync_tool_allow_records_outcome(bastion):
    @bastion_guard(bastion, tool_name="my_tool")
    def my_tool(value: int) -> str:
        return f"got {value}"

    result = my_tool(value=5)
    assert result == "got 5"
    # 1 decision + 1 outcome
    assert bastion.store.count() == 2


def test_sync_tool_deny_raises(bastion):
    @bastion_guard(bastion, tool_name="delete_file")
    def delete_file(path: str) -> str:
        return f"deleted {path}"

    with pytest.raises(BastionPermissionError) as exc:
        delete_file(path="/tmp/x")
    assert "delete_file" in str(exc.value)
    # 1 decision (deny), no outcome since tool didn't run
    assert bastion.store.count() == 1


def test_sync_tool_failure_records_error(bastion):
    @bastion_guard(bastion, tool_name="explode")
    def explode() -> str:
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        explode()
    # decision (allow) + outcome (failure)
    assert bastion.store.count() == 2


def test_async_tool_allow(bastion):
    @bastion_guard(bastion, tool_name="async_tool")
    async def async_tool(x: int) -> int:
        return x * 2

    result = asyncio.run(async_tool(x=21))
    assert result == 42
    assert bastion.store.count() == 2


def test_async_tool_deny(bastion):
    @bastion_guard(bastion, tool_name="delete_file")
    async def delete_file(path: str) -> str:
        return path

    with pytest.raises(BastionPermissionError):
        asyncio.run(delete_file(path="/tmp/x"))


def test_tool_name_defaults_to_function_name(bastion):
    @bastion_guard(bastion)  # no tool_name override
    def delete_file() -> str:
        return "ok"

    with pytest.raises(BastionPermissionError):
        delete_file()


def test_example_sketch_imports():
    """The example sketch must remain importable."""
    import importlib.util
    from pathlib import Path

    sketch = Path(__file__).resolve().parent.parent / "examples" / "openai_sketch.py"
    spec = importlib.util.spec_from_file_location("openai_sketch", sketch)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert hasattr(module, "main")
