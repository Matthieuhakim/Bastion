"""Standard filesystem locations for Bastion agent state."""

from __future__ import annotations

import os
from pathlib import Path


def bastion_home() -> Path:
    configured = os.environ.get("BASTION_HOME")
    if configured:
        return Path(configured).expanduser().resolve()

    return project_root() / ".bastion"


def project_root(start: str | Path | None = None) -> Path:
    """Return the nearest enclosing git repo root, or cwd when none exists."""
    current = Path(start or Path.cwd()).expanduser().resolve()
    if current.is_file():
        current = current.parent

    for candidate in (current, *current.parents):
        if (candidate / ".git").exists():
            return candidate

    return current


def agent_db_path(agent_id: str) -> Path:
    return bastion_home() / f"{agent_id}.db"


def agent_keys_dir(agent_id: str) -> Path:
    return bastion_home() / "agent_keys" / agent_id


def agent_private_key_path(agent_id: str) -> Path:
    return agent_keys_dir(agent_id) / "private.pem"


def agent_public_key_path(agent_id: str) -> Path:
    return agent_keys_dir(agent_id) / "public.pem"


def is_safe_agent_id(agent_id: str) -> bool:
    """Reject agent_ids that could escape the bastion home directory."""
    if not agent_id:
        return False
    if "/" in agent_id or "\\" in agent_id or ".." in agent_id:
        return False
    if agent_id.startswith("."):
        return False
    return True
