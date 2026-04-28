"""Tests for the bastion.paths helpers."""

from __future__ import annotations

import pytest

from bastion import paths


@pytest.mark.parametrize(
    "agent_id",
    ["my-agent", "shopping_agent_v2", "agent-123", "A_b-9"],
)
def test_safe_agent_ids_accepted(agent_id):
    assert paths.is_safe_agent_id(agent_id)


@pytest.mark.parametrize(
    "agent_id",
    [
        "",
        "../escape",
        "ok/then/not",
        "back\\slash",
        ".hidden",
        "..",
    ],
)
def test_unsafe_agent_ids_rejected(agent_id):
    assert not paths.is_safe_agent_id(agent_id)


def test_paths_compose_under_bastion_home():
    home = paths.bastion_home()
    assert paths.agent_db_path("foo").parent == home
    assert paths.agent_keys_dir("foo").parent == home / "agent_keys"
    assert paths.agent_private_key_path("foo").name == "private.pem"
    assert paths.agent_public_key_path("foo").name == "public.pem"


def test_bastion_home_uses_env_override(tmp_path, monkeypatch):
    configured = tmp_path / "custom-home"
    monkeypatch.setenv("BASTION_HOME", str(configured))

    assert paths.bastion_home() == configured.resolve()


def test_bastion_home_defaults_to_git_root_dot_bastion(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    nested = repo / "app" / "agent"
    nested.mkdir(parents=True)
    (repo / ".git").mkdir()
    monkeypatch.delenv("BASTION_HOME", raising=False)
    monkeypatch.chdir(nested)

    assert paths.bastion_home() == repo.resolve() / ".bastion"


def test_bastion_home_defaults_to_cwd_without_git_root(tmp_path, monkeypatch):
    workdir = tmp_path / "agent"
    workdir.mkdir()
    monkeypatch.delenv("BASTION_HOME", raising=False)
    monkeypatch.chdir(workdir)

    assert paths.bastion_home() == workdir.resolve() / ".bastion"
