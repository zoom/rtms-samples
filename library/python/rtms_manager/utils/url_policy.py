"""Validation and selection policy for RTMS WebSocket callback URLs."""

import os
from typing import Any, Iterable, Optional
from urllib.parse import urlparse

DEFAULT_ALLOWED_RTMS_HOST_SUFFIXES = ('zoom.us',)


def is_allowed_rtms_callback_url(value: Any, allowed_hosts: Optional[Iterable[str]] = None) -> bool:
    """Validate an RTMS signaling or media callback URL against the host allowlist.

    Only ``ws`` and ``wss`` URLs up to 2048 characters whose host matches
    ``allowed_hosts`` (or the comma-separated ``RTMS_ALLOWED_MEDIA_HOSTS`` env
    var, defaulting to ``zoom.us``) are accepted.
    """
    if not isinstance(value, str) or len(value) == 0 or len(value) > 2048:
        return False

    try:
        parsed = urlparse(value)
    except ValueError:
        return False

    if parsed.scheme not in ('wss', 'ws') or not parsed.hostname:
        return False

    if allowed_hosts is None:
        env_hosts = os.environ.get('RTMS_ALLOWED_MEDIA_HOSTS', '')
        configured: Iterable[str] = (
            env_hosts.split(',') if env_hosts.strip() else DEFAULT_ALLOWED_RTMS_HOST_SUFFIXES
        )
    else:
        configured = allowed_hosts

    suffixes = [
        str(host).strip().lower().lstrip('.')
        for host in configured
        if str(host).strip().lstrip('.')
    ]
    if not suffixes:
        return True

    host = parsed.hostname.lower()
    return any(host == suffix or host.endswith(f'.{suffix}') for suffix in suffixes)


def select_allowed_rtms_callback_url(
    value: Any,
    allowed_hosts: Optional[Iterable[str]] = None,
) -> Optional[str]:
    """Select the first allowlisted ``ws``/``wss`` URL from a comma-separated V2 value."""
    if not isinstance(value, str) or not value.strip():
        return None
    for raw_url in value.split(','):
        url = raw_url.strip()
        if is_allowed_rtms_callback_url(url, allowed_hosts):
            return url
    return None


def select_websocket_url(value: Any) -> Optional[str]:
    """Return the first ``ws``/``wss`` entry from a possibly comma-separated URL string."""
    if not isinstance(value, str) or not value.strip():
        return None
    for raw_url in value.split(','):
        url = raw_url.strip()
        if url.startswith('wss://') or url.startswith('ws://'):
            return url
    return None
