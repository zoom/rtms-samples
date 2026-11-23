from typing import Any, Optional


def select_websocket_url(value: Any) -> Optional[str]:
    """
    RTMS V2 can return more than one URL for an endpoint, separated by commas,
    for example ``wss://host/ws,srt://host:port``. WebSocket connections must
    use the ws/wss entry. Returns the first ws/wss URL, or None.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    for url in value.split(','):
        url = url.strip()
        if url.startswith('wss://') or url.startswith('ws://'):
            return url
    return None
