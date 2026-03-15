"""Bastion API client."""

from __future__ import annotations

import httpx


class BastionClient:
    """Client for interacting with the Bastion trust proxy API."""

    def __init__(self, base_url: str, api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._client = httpx.Client(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {self.api_key}"},
        )

    def health(self) -> dict:
        """Check the health of the Bastion API."""
        response = self._client.get("/health")
        response.raise_for_status()
        return response.json()

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def __enter__(self) -> BastionClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
