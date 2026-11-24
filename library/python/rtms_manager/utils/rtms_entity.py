from typing import Any, Dict, Optional

from .url_policy import select_allowed_rtms_callback_url, select_websocket_url


RTMS_ENTITY_KEYS = {
    'meeting': 'meeting_uuid',
    'webinar': 'webinar_uuid',
    'video_sdk': 'session_id',
    'contact_center': 'engagement_id',
    'phone': 'call_id',
}


def normalize_rtms_type(rtms_type: Optional[str]) -> str:
    if rtms_type in ('videoSdk', 'session', 'video'):
        return 'video_sdk'
    if rtms_type == 'contactCenter':
        return 'contact_center'
    return rtms_type or 'meeting'


def get_rtms_entity_key(rtms_type: Optional[str]) -> str:
    return RTMS_ENTITY_KEYS.get(normalize_rtms_type(rtms_type), 'meeting_uuid')


def build_rtms_entity_payload(rtms_type: Optional[str], rtms_id: str) -> Dict[str, str]:
    return {get_rtms_entity_key(rtms_type): rtms_id}


def get_rtms_id_from_payload(rtms_type: Optional[str], payload: Dict[str, Any]) -> Optional[str]:
    normalized_type = normalize_rtms_type(rtms_type)

    if normalized_type == 'contact_center':
        return payload.get('engagement_id') or payload.get('session_id')

    return payload.get(get_rtms_entity_key(normalized_type))


def _pick_websocket_url(value: Any) -> str:
    # V2 values can be comma-separated (wss://...,srt://...). Prefer an allowed
    # WebSocket entry; fall back to the raw value so the caller's allowlist
    # check still reports a clear error instead of an empty URL.
    if not isinstance(value, str):
        return ''
    return select_allowed_rtms_callback_url(value) or select_websocket_url(value) or value


def get_preferred_media_url(rtms_type: Optional[str], server_urls: Any, preferred_type: Optional[str] = None) -> str:
    if isinstance(server_urls, str):
        return _pick_websocket_url(server_urls)

    if not isinstance(server_urls, dict):
        return ''

    if preferred_type and server_urls.get(preferred_type):
        return _pick_websocket_url(server_urls[preferred_type])

    if normalize_rtms_type(rtms_type) == 'contact_center' and server_urls.get('audio'):
        return _pick_websocket_url(server_urls['audio'])

    if server_urls.get('audio'):
        return _pick_websocket_url(server_urls['audio'])

    for value in server_urls.values():
        url = _pick_websocket_url(value)
        if url:
            return url

    return ''
