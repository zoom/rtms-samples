"""Redact sensitive credential fields before logging config objects."""

from typing import Any

_SECRET_KEYS = (
    'clientid',
    'client_id',
    'clientsecret',
    'client_secret',
    'zoomsecrettoken',
    'videosecrettoken',
    'accountid',
    'account_id',
    'secret',
    'token',
    'apikey',
    'api_key',
    'password',
    'signature',
)


def _is_secret_key(key: Any) -> bool:
    if not isinstance(key, str):
        return False
    lowered = key.lower()
    return any(needle in lowered for needle in _SECRET_KEYS)


def redact_secrets(obj: Any) -> Any:
    """Return a deep copy of ``obj`` with secret values replaced by ``[REDACTED]``."""
    if isinstance(obj, dict):
        return {
            key: ('[REDACTED]' if _is_secret_key(key) and value else redact_secrets(value))
            for key, value in obj.items()
        }
    if isinstance(obj, list):
        return [redact_secrets(item) for item in obj]
    if isinstance(obj, tuple):
        return tuple(redact_secrets(item) for item in obj)
    return obj
