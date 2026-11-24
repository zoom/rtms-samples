"""Transcript rewind: run with `python3 -m unittest discover -s tests` from library/python."""

import asyncio
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rtms_manager import TranscriptRevisionStore  # noqa: E402
from rtms_manager.media_socket import _handle_media_messages  # noqa: E402


class FakeSocket:
    def __init__(self, messages):
        self._messages = [json.dumps(m) for m in messages]

    def __aiter__(self):
        return self._iter()

    async def _iter(self):
        for message in self._messages:
            yield message

    async def send(self, _):
        pass


def transcript_events(contents, rtms_type='meeting'):
    events = []
    conn = {'rtms_type': rtms_type, 'media': {'transcript': {'state': 'ready'}}}
    socket = FakeSocket([{'msg_type': 17, 'content': c} for c in contents])

    def emit(name, payload, *_):
        if name == 'transcript':
            events.append(payload)

    asyncio.run(_handle_media_messages(
        socket, 'meeting-1', 'stream-1', conn, 'id', 'secret', 'transcript', 8, emit
    ))
    return events


class TranscriptRewindTest(unittest.TestCase):
    def test_meeting_transcript_events_expose_rewind_fields(self):
        first, revision = transcript_events([
            {'user_id': 16778240, 'user_name': 'Ana', 'sentence_id': 0, 'attribute': 1,
             'data': 'Hello ward', 'start_time': 10, 'end_time': 20, 'language': 9},
            {'user_id': 16778240, 'user_name': 'Ana', 'sentence_id': 0, 'attribute': '2',
             'data': 'Hello world', 'start_time': 10, 'end_time': 25},
        ])
        self.assertEqual(first['sentence_id'], 0)
        self.assertFalse(first['is_update'])
        self.assertEqual(first['language'], 9)
        self.assertEqual(revision['sentence_id'], 0)
        self.assertTrue(revision['is_update'])
        self.assertEqual(revision['end_time'], 25)

    def test_phone_transcript_uses_channel_id(self):
        (event,) = transcript_events(
            [{'channel_id': 'ch-a', 'sentence_id': 3, 'attribute': 2, 'data': 'Hi'}], 'phone'
        )
        self.assertEqual(event['channel_id'], 'ch-a')
        self.assertEqual(event['user_id'], 'ch-a')
        self.assertTrue(event['is_update'])

    def test_store_replaces_revised_sentences_in_place(self):
        store = TranscriptRevisionStore()
        events = transcript_events([
            {'user_id': 1, 'user_name': 'Ana', 'sentence_id': 7, 'attribute': 1, 'data': 'Hello ward', 'start_time': 10},
            {'user_id': 2, 'user_name': 'Ben', 'sentence_id': 7, 'attribute': 1, 'data': 'Hi', 'start_time': 20},
            {'user_id': 1, 'user_name': 'Ana', 'sentence_id': 7, 'attribute': 2, 'data': 'Hello world', 'start_time': 10},
            {'user_id': 1, 'user_name': 'Ana', 'data': 'No sentence id', 'start_time': 30},
        ])
        self.assertEqual([store.apply(e)['action'] for e in events], ['new', 'new', 'updated', 'new'])
        self.assertEqual([s['text'] for s in store.sentences('stream-1')], ['Hello world', 'Hi', 'No sentence id'])
        self.assertEqual(store.sentences()[0]['revision'], 1)

        late = {'stream_id': 'stream-1', 'user_id': 3, 'sentence_id': 1, 'is_update': True, 'text': 'Late'}
        self.assertEqual(store.apply(late)['action'], 'recovered')
        self.assertEqual(store.apply({'stream_id': 'call', 'channel_id': 'a', 'sentence_id': 0, 'text': 'A'})['action'], 'new')
        self.assertEqual(store.apply({'stream_id': 'call', 'channel_id': 'b', 'sentence_id': 0, 'text': 'B'})['action'], 'new')

        store.clear('stream-1')
        self.assertEqual([s['text'] for s in store.sentences()], ['A', 'B'])


if __name__ == '__main__':
    unittest.main()
