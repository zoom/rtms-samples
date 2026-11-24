"""Keeps the latest text of each RTMS transcript sentence (transcript rewind).

RTMS can send a sentence and later a correction for it. The correction carries
``attribute: 2`` (``is_update: True``), the same ``sentence_id``, and the full
replacement text, so it must replace the earlier line instead of appending.

Sentences are keyed by (stream_id, channel_id or user_id, sentence_id). Sentence
IDs are not unique across Phone channels, and 0 is a valid ID.
"""

from typing import Any, Dict, List, Optional


class TranscriptRevisionStore:
    def __init__(self) -> None:
        self._sentences: Dict[str, Dict[str, Any]] = {}
        self._order = 0

    def __len__(self) -> int:
        return len(self._sentences)

    def apply(self, event: Dict[str, Any]) -> Dict[str, Any]:
        """Add or replace a sentence from a ``transcript`` event.

        Returns ``{'action', 'key', 'sentence'}``. ``action`` is ``new``,
        ``updated`` (a revision replaced a known sentence), ``recovered`` (a
        revision for an unknown sentence, for example after a reconnect), or
        ``replaced`` (a non-revision packet reused a known sentence ID).
        """
        stream_id = _first(event, 'stream_id', 'rtms_id', 'meeting_id')
        speaker = _first(event, 'channel_id', 'user_id')
        sentence_id = event.get('sentence_id')
        is_update = event.get('is_update') is True or _is_revision(event.get('attribute'))
        sentence = {
            'stream_id': stream_id,
            'rtms_id': _first(event, 'rtms_id', 'meeting_id'),
            'channel_id': event.get('channel_id'),
            'user_id': event.get('user_id'),
            'user_name': event.get('user_name'),
            'sentence_id': sentence_id,
            'text': '' if event.get('text') is None else str(event.get('text')),
            'language': event.get('language'),
            'start_time': event.get('start_time'),
            'end_time': event.get('end_time'),
            'timestamp': event.get('timestamp'),
            'revision': 0,
        }

        # Without a sentence ID there is nothing to revise; keep it as a new line.
        if sentence_id is None:
            key = f'{stream_id}:{speaker}:#{self._order}'
            sentence['order'] = self._next_order()
            self._sentences[key] = sentence
            return {'action': 'new', 'key': key, 'sentence': sentence}

        key = f'{stream_id}:{speaker}:{sentence_id}'
        previous = self._sentences.get(key)
        if previous:
            sentence['order'] = previous['order']
            sentence['revision'] = previous['revision'] + 1
            # A revision may omit timing; keep the original position in that case.
            if sentence['start_time'] is None:
                sentence['start_time'] = previous['start_time']
            if sentence['end_time'] is None:
                sentence['end_time'] = previous['end_time']
        else:
            sentence['order'] = self._next_order()
        self._sentences[key] = sentence

        if is_update:
            action = 'updated' if previous else 'recovered'
        else:
            action = 'replaced' if previous else 'new'
        return {'action': action, 'key': key, 'sentence': sentence}

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        return self._sentences.get(key)

    def sentences(self, stream_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Sentences ordered by start time, then arrival. Pass stream_id to filter."""
        items = [
            s for s in self._sentences.values()
            if stream_id is None or s['stream_id'] == stream_id
        ]
        return sorted(items, key=lambda s: (_time_of(s), s['order']))

    def clear(self, stream_id: Optional[str] = None) -> None:
        """Remove every sentence, or only those of one stream (call on stream stop)."""
        if stream_id is None:
            self._sentences.clear()
            return
        for key in [k for k, s in self._sentences.items() if s['stream_id'] == stream_id]:
            del self._sentences[key]

    def _next_order(self) -> int:
        order = self._order
        self._order += 1
        return order


def _first(event: Dict[str, Any], *names: str) -> Any:
    for name in names:
        if event.get(name) is not None:
            return event[name]
    return None


def _is_revision(attribute: Any) -> bool:
    try:
        return int(attribute) == 2
    except (TypeError, ValueError):
        return False


def _time_of(sentence: Dict[str, Any]) -> float:
    value = sentence['start_time'] if sentence['start_time'] is not None else sentence['timestamp']
    return value or 0
