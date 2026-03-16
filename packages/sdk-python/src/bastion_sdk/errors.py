"""Typed error classes for Bastion API responses."""

from __future__ import annotations

import httpx


class BastionError(Exception):
    """Base error for all Bastion API errors."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class BastionValidationError(BastionError):
    """Raised for 400 Bad Request responses."""

    def __init__(self, message: str) -> None:
        super().__init__(400, message)


class BastionUnauthorizedError(BastionError):
    """Raised for 401 Unauthorized responses."""

    def __init__(self, message: str) -> None:
        super().__init__(401, message)


class BastionForbiddenError(BastionError):
    """Raised for 403 Forbidden responses (policy DENY, HITL denial/timeout)."""

    def __init__(self, message: str) -> None:
        super().__init__(403, message)


class BastionNotFoundError(BastionError):
    """Raised for 404 Not Found responses."""

    def __init__(self, message: str) -> None:
        super().__init__(404, message)


class BastionConflictError(BastionError):
    """Raised for 409 Conflict responses."""

    def __init__(self, message: str) -> None:
        super().__init__(409, message)


class BastionBadGatewayError(BastionError):
    """Raised for 502 Bad Gateway responses (upstream HTTP failure)."""

    def __init__(self, message: str) -> None:
        super().__init__(502, message)


_STATUS_MAP: dict[int, type[BastionError]] = {
    400: BastionValidationError,
    401: BastionUnauthorizedError,
    403: BastionForbiddenError,
    404: BastionNotFoundError,
    409: BastionConflictError,
    502: BastionBadGatewayError,
}


def raise_for_status(response: httpx.Response) -> None:
    """Raise the appropriate BastionError subclass for non-2xx responses."""
    if response.is_success:
        return
    try:
        body = response.json()
        message = body.get("message", response.reason_phrase or "Unknown error")
    except Exception:
        message = response.reason_phrase or "Unknown error"
    error_cls = _STATUS_MAP.get(response.status_code, BastionError)
    if error_cls is BastionError:
        raise BastionError(response.status_code, message)
    raise error_cls(message)
