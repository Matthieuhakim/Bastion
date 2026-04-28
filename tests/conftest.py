"""Shared pytest fixtures and bootstrap.

Loads .env from the repo root so live-LLM tests pick up ANTHROPIC_API_KEY
without the user having to export it manually. The SDK itself does NOT
do this — only the test harness, to keep the library dependency-light.
"""

from __future__ import annotations

from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass
