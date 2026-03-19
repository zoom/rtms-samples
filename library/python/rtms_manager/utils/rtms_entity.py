from typing import Any, Dict, Optional


RTMS_ENTITY_KEYS = {
    'meeting': 'meeting_uuid',
    'webinar': 'webinar_uuid',
    'video_sdk': 'session_id',
    'contact_center': 'engagement_id',
    'phone': 'call_id',
}


def normalize_rtms_type(rtms_type: Optional[str]) -> str:
    if rtms_type == 'videoSdk':
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


def get_preferred_media_url(rtms_type: Optional[str], server_urls: Any, preferred_type: Optional[str] = None) -> str:
    if isinstance(server_urls, str):
        return server_urls

    if not isinstance(server_urls, dict):
        return ''

    if preferred_type and server_urls.get(preferred_type):
        return server_urls[preferred_type]

    if normalize_rtms_type(rtms_type) == 'contact_center' and server_urls.get('audio'):
        return server_urls['audio']

    if server_urls.get('all'):
        return server_urls['all']

    if server_urls.get('audio'):
        return server_urls['audio']

    for value in server_urls.values():
        if isinstance(value, str) and value.startswith('ws'):
            return value

    return ''
