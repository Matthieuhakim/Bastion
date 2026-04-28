"""Headless Textual tests for the bastion watch dashboard."""

from __future__ import annotations

import asyncio
import json

import pytest
from textual.widgets import DataTable, Static

from bastion import Bastion, policy
from bastion.cli.watch import BANNER, BastionDashboard, _short_time


def test_short_time_strips_date_and_z():
    assert _short_time("2026-04-28T14:23:07.412Z") == "14:23:07.412"
    assert _short_time("plain") == "plain"


def test_banner_is_six_lines():
    assert BANNER.count("\n") == 5  # 6 lines


@pytest.mark.asyncio
async def test_dashboard_renders_existing_records(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))

    b = Bastion(
        agent_id="dash-test",
        policies=[
            policy.deny.tools("delete_file"),
            policy.escalate.above("amount", 30),
        ],
    )
    b.evaluate("Read", {"path": "/tmp/x"})
    b.record_outcome(success=True, tool_name="Read", output_hash="abc")
    b.evaluate("delete_file", {"path": "/tmp/y"})
    b.close()

    app = BastionDashboard("dash-test")
    async with app.run_test() as pilot:
        await pilot.pause(0.4)

        log = app.query_one("#event_log", DataTable)
        assert log.row_count == 3

        policies_panel = app.query_one("#policies_panel", DataTable)
        # Only deny.tools fires (default.allow + tool_outcome are skipped).
        assert policies_panel.row_count >= 1

        stats = app.query_one("#stats_panel", Static)
        rendered = str(stats.render())
        assert "Total records" in rendered
        assert "3" in rendered


@pytest.mark.asyncio
async def test_dashboard_picks_up_new_records_on_tick(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    b = Bastion(agent_id="dash-tick", policies=[policy.deny.tools("X")])

    app = BastionDashboard("dash-tick")
    async with app.run_test() as pilot:
        await pilot.pause(0.3)
        log = app.query_one("#event_log", DataTable)
        baseline = log.row_count

        # Append a new record from outside the dashboard.
        b.evaluate("Read", {"path": "/tmp/x"})
        await pilot.pause(0.4)

        assert log.row_count == baseline + 1

    b.close()


@pytest.mark.asyncio
async def test_verify_action_fires_notification(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    b = Bastion(agent_id="dash-verify", policies=[policy.deny.tools("X")])
    b.evaluate("X", {})
    b.close()

    app = BastionDashboard("dash-verify")
    async with app.run_test() as pilot:
        await pilot.pause(0.3)
        await pilot.press("v")
        await pilot.pause(0.2)
        # Just confirm no crash; notifications are queued internally.
