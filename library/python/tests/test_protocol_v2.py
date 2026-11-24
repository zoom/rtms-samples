"""RTMS protocol V2 tests: run with `python3 -m unittest discover -s tests` from library/python."""

import asyncio
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rtms_manager import RTMSManager, RTMSError  # noqa: E402
from rtms_manager.rtms_manager import calculate_effective_flags  # noqa: E402
from rtms_manager.signaling_socket import (  # noqa: E402
    get_protocol_version,
    handle_signaling_message,
)
from rtms_manager.media_socket import build_media_handshake_message  # noqa: E402


class FakeSignalingSocket:
    def __init__(self):
        self.sent = []
        self.closed = False

    async def send(self, data):
        self.sent.append(json.loads(data))

    async def close(self):
        self.closed = True


def make_conn(config=None, rtms_type='meeting'):
    return {
        'rtms_type': rtms_type,
        'config': dict(config or {}),
        'should_reconnect': True,
        'signaling': {'socket': None, 'state': 'authenticated'},
        'media': {},
    }


def run_subscribe(conn, media_types=RTMSManager.MEDIA.AUDIO):
    ws = FakeSignalingSocket()
    conn['signaling']['socket'] = ws
    asyncio.run(handle_signaling_message(
        json.dumps({
            'msg_type': 2,
            'protocol_version': get_protocol_version(conn),
            'status_code': 0,
            'media_server': {'server_urls': {}},
        }),
        'meeting-1', 'stream-1', ws, conn, lambda *_: None, media_types, 'id', 'secret',
    ))
    return next((msg for msg in ws.sent if msg.get('msg_type') == 5), None)


class ProtocolV2Test(unittest.TestCase):
    def test_meeting_streams_default_to_v2_and_can_opt_back_to_v1(self):
        self.assertEqual(get_protocol_version(make_conn()), 2)
        self.assertEqual(get_protocol_version(make_conn({'protocol_version': 1})), 1)

    def test_v2_subscriptions_use_event_code_only_and_skip_automatic_events(self):
        payload = run_subscribe(make_conn({'subscribe_all_known_events': True}))
        self.assertIsNotNone(payload)
        codes = [entry['event_code'] for entry in payload['events']]
        self.assertTrue(all('event_type' not in entry for entry in payload['events']))
        self.assertEqual(codes, [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011])

    def test_v2_default_subscription_maps_active_speaker_join_and_leave(self):
        payload = run_subscribe(make_conn())
        self.assertEqual(payload['events'], [
            {'event_code': 1000, 'subscribe': True},
            {'event_code': 1001, 'subscribe': True},
            {'event_code': 1002, 'subscribe': True},
        ])

    def test_v1_subscriptions_keep_legacy_event_type(self):
        payload = run_subscribe(make_conn({'protocol_version': 1}))
        self.assertEqual([entry['event_type'] for entry in payload['events']], [2, 3, 4])
        self.assertTrue(all('event_code' not in entry for entry in payload['events']))

    def test_v2_data_handshake_omits_payload_encryption_while_v1_includes_it(self):
        v2_msg = build_media_handshake_message('m-1', 's-1', make_conn(), 'id', 'secret', 'audio', 1)
        self.assertEqual(v2_msg['protocol_version'], 2)
        self.assertNotIn('payload_encryption', v2_msg)

        v1_msg = build_media_handshake_message('m-1', 's-1', make_conn({'protocol_version': 1}), 'id', 'secret', 'audio', 1)
        self.assertEqual(v1_msg['protocol_version'], 1)
        self.assertIs(v1_msg['payload_encryption'], False)

    def test_v2_session_and_automatic_event_codes_reach_handlers(self):
        conn = make_conn()
        ws = FakeSignalingSocket()
        events = []

        def emit(name, payload, *_):
            events.append((name, payload))

        async def send_all():
            for event in [
                {'event_code': 1, 'timestamp': 12345},
                {'event_code': 1001, 'timestamp': 1, 'participants': [{'user_id': 7, 'user_name': 'Ada'}]},
                {'event_code': 1005, 'timestamp': 2, 'participants': [{'user_id': 7, 'user_name': 'Ada'}]},
                {'event_code': 1007, 'timestamp': 3},
                {'event_code': 2, 'timestamp': 4, 'media_type': 1},
                {'event_code': 3, 'timestamp': 5, 'connection_id': 'video-1'},
                {'event_code': 4, 'timestamp': 6, 'media_type': 2, 'participants': [{'user_id': 7, 'user_name': 'Ada', 'participant_uuid': 'u-7'}]},
            ]:
                await handle_signaling_message(
                    json.dumps({'msg_type': 6, 'event': event}),
                    'meeting-1', 'stream-1', ws, conn, emit, 1, 'id', 'secret',
                )

        asyncio.run(send_all())

        self.assertEqual(conn['first_packet_timestamp'], 12345)
        generic = [payload for name, payload in events if name == 'event']
        self.assertEqual(
            [(p['eventType'], p['eventCode']) for p in generic],
            [(1, 1), (3, 1001), (8, 1005), (10, 1007), (7, 2), (15, 3), (None, 4)],
        )
        self.assertTrue(any(name == 'participant_video_on' for name, _ in events))
        self.assertEqual(next(p for name, p in events if name == 'chat_group_created')['eventCode'], 1007)
        self.assertEqual(next(p for name, p in events if name == 'media_connection_interrupted')['mediaType'], 1)
        self.assertEqual(next(p for name, p in events if name == 'video_subscription_terminated')['connectionId'], 'video-1')
        user_info = next(p for name, p in events if name == 'media_data_user_info')
        self.assertEqual(user_info['participants'][0]['participantUuid'], 'u-7')

    def test_v1_events_still_report_matching_v2_event_code(self):
        conn = make_conn({'protocol_version': 1})
        events = []
        asyncio.run(handle_signaling_message(
            json.dumps({'msg_type': 6, 'event': {'event_type': 4, 'user_id': 7}}),
            'meeting-1', 'stream-1', FakeSignalingSocket(), conn, lambda n, p, *_: events.append((n, p)), 1, 'id', 'secret',
        ))
        generic = next(p for name, p in events if name == 'event')
        self.assertEqual(generic['eventType'], 4)
        self.assertEqual(generic['eventCode'], 1002)

    def test_single_server_urls_string_serves_every_requested_media_type(self):
        self.assertEqual(calculate_effective_flags(1 | 2 | 8, 'wss://m.zoom.us/ws,srt://m.zoom.us:1'), 11)
        self.assertEqual(calculate_effective_flags(1 | 2, {'audio': 'wss://a.zoom.us'}), 1)
        self.assertEqual(calculate_effective_flags(1, ''), 0)

    def test_request_error_resp_surfaces_rtms_error_with_v2_status(self):
        conn = make_conn()
        events = []
        asyncio.run(handle_signaling_message(
            json.dumps({'msg_type': 30, 'request_msg_type': 5, 'status_code': 57}),
            'meeting-1', 'stream-1', FakeSignalingSocket(), conn, lambda n, p, *_: events.append((n, p)), 1, 'id', 'secret',
        ))
        err = next(p for name, p in events if name == 'error')
        self.assertIsInstance(err, RTMSError)
        self.assertEqual(err.zoom_status, 57)
        self.assertRegex(err.to_short_string(), r'event_code|INVALID_EVENT_CODE')

    def test_stream_state_terminated_closes_sockets_and_disables_reconnect(self):
        sig_ws = FakeSignalingSocket()
        audio_ws = FakeSignalingSocket()
        conn = make_conn()
        conn['signaling']['socket'] = sig_ws
        conn['media']['audio'] = {'socket': audio_ws, 'state': 'streaming', 'reconnect_task': None}
        events = []
        asyncio.run(handle_signaling_message(
            json.dumps({'msg_type': 8, 'state': 4, 'reason': 6}),
            'meeting-1', 'stream-1', sig_ws, conn, lambda n, p, *_: events.append((n, p)), 1, 'id', 'secret',
        ))
        self.assertFalse(conn['should_reconnect'])
        self.assertTrue(sig_ws.closed)
        self.assertTrue(audio_ws.closed)
        state_evt = next(p for name, p in events if name == 'stream_state_changed')
        self.assertEqual(state_evt['state'], 4)
        self.assertEqual(state_evt['reason'], 6)


if __name__ == '__main__':
    unittest.main()
