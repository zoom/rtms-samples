"""Zoom Phone RTMS tests: run with `python3 -m unittest discover -s tests` from library/python."""

import asyncio
import base64
import json
import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rtms_manager import RTMSManager, RTMS_EVENT_CODES  # noqa: E402
from rtms_manager.media_socket import build_media_handshake_message, handle_media_message  # noqa: E402
from rtms_manager.signaling_socket import get_protocol_version, handle_signaling_message  # noqa: E402
from rtms_manager.utils.rtms_entity import get_preferred_media_url  # noqa: E402
from rtms_manager.utils.url_policy import select_allowed_rtms_callback_url  # noqa: E402


class FakeSocket:
    def __init__(self):
        self.sent = []
        self.closed = False

    async def send(self, data):
        self.sent.append(json.loads(data))

    async def close(self):
        self.closed = True


def make_phone_conn(config=None):
    return {
        'rtms_type': 'phone',
        'config': dict(config or {}),
        'should_reconnect': True,
        'signaling': {'socket': None, 'state': 'authenticated'},
        'media': {},
        'phone_call_info': {'host_channel_id': None, 'participants': []},
    }


class PhoneRTMSTest(unittest.TestCase):
    def tearDown(self):
        RTMSManager.reset()

    def test_selects_wss_url_from_comma_separated_phone_server_urls(self):
        self.assertEqual(
            select_allowed_rtms_callback_url('srt://media.zoom.us:9000, wss://signal.zoom.us/ws'),
            'wss://signal.zoom.us/ws',
        )
        self.assertIsNone(select_allowed_rtms_callback_url('srt://media.zoom.us:9000'))
        self.assertEqual(
            get_preferred_media_url('phone', {'transcript': 'wss://t.zoom.us/ws,srt://t.zoom.us:1'}, 'transcript'),
            'wss://t.zoom.us/ws',
        )

    def test_phone_streams_always_use_v2_or_later_and_preset_matches(self):
        self.assertEqual(get_protocol_version(make_phone_conn()), 2)
        self.assertEqual(get_protocol_version(make_phone_conn({'protocol_version': 1})), 2)
        self.assertEqual(get_protocol_version(make_phone_conn({'protocol_version': 3})), 3)
        self.assertEqual(
            RTMSManager.PRESETS['PHONE']['media_types'],
            RTMSManager.MEDIA.AUDIO | RTMSManager.MEDIA.TRANSCRIPT,
        )

    def test_phone_skips_event_subscription_and_omits_default_media_params(self):
        conn = make_phone_conn()
        ws = FakeSocket()
        conn['signaling']['socket'] = ws
        asyncio.run(handle_signaling_message(
            json.dumps({
                'msg_type': 2,
                'protocol_version': 2,
                'status_code': 0,
                'media_server': {'server_urls': {}},
            }),
            'call-1', 'stream-1', ws, conn, lambda *_: None, 9, 'id', 'secret',
        ))
        self.assertFalse(any(msg.get('msg_type') == 5 for msg in ws.sent))

        handshake = build_media_handshake_message('call-1', 'stream-1', conn, 'id', 'secret', 'audio', 1)
        self.assertEqual(handshake['call_id'], 'call-1')
        self.assertNotIn('media_params', handshake)

        custom_conn = make_phone_conn({'phone_media_params': {'audio': {'content_type': 2, 'codec': 1}}})
        custom_handshake = build_media_handshake_message('call-1', 'stream-1', custom_conn, 'id', 'secret', 'audio', 1)
        self.assertEqual(custom_handshake['media_params'], {'audio': {'content_type': 2, 'codec': 1}})

    def test_call_info_updated_stores_participants_and_names_audio_and_transcript(self):
        conn = make_phone_conn()
        signaling_events = []
        asyncio.run(handle_signaling_message(
            json.dumps({
                'msg_type': 'EVENT_UPDATE',
                'event': {
                    'event_code': RTMS_EVENT_CODES['ZP_CALL_INFO_UPDATED'],
                    'host_channel_id': 'ch-a',
                    'participants': [
                        {'name': 'Alice', 'phone_number/extension_number': '1001', 'channel_id': 'ch-a'},
                        {'name': 'pstn', 'phone_number/extension_number': '+6512345678', 'channel_id': 'ch-b'},
                    ],
                    'timestamp': 1,
                },
            }),
            'call-1', 'stream-1', FakeSocket(), conn, lambda n, p, *_: signaling_events.append((n, p)), 9, 'id', 'secret',
        ))

        info_event = next(p for name, p in signaling_events if name == 'phone_call_info_updated')
        self.assertEqual(info_event['hostChannelId'], 'ch-a')
        self.assertEqual(info_event['participants'][1], {'channel_id': 'ch-b', 'name': 'pstn', 'number': '+6512345678'})
        self.assertEqual(next(p for name, p in signaling_events if name == 'event')['eventCode'], 3000)

        media_events = []

        async def feed_media():
            await handle_media_message(
                json.dumps({
                    'msg_type': 17,
                    'content': {
                        'channel_id': 'ch-a',
                        'attribute': 2,
                        'language': 9,
                        'data': 'Your support case has been updated.',
                        'timestamp': 3,
                        'start_time': 1,
                        'end_time': 2,
                        'sentence_id': 0,
                    },
                }),
                FakeSocket(), 'call-1', 'stream-1', conn, 'transcript',
                lambda n, p, *_: media_events.append((n, p)),
            )
            await handle_media_message(
                json.dumps({
                    'msg_type': 14,
                    'content': {
                        'channel_id': 'ch-b',
                        'source': 'caller',
                        'data': base64.b64encode(b'\x01\x02').decode('ascii'),
                        'timestamp': 4,
                    },
                }),
                FakeSocket(), 'call-1', 'stream-1', conn, 'audio',
                lambda n, p, *_: media_events.append((n, p)),
            )

        asyncio.run(feed_media())

        transcript = next(p for name, p in media_events if name == 'transcript')
        self.assertEqual(transcript['user_id'], 'ch-a')
        self.assertEqual(transcript['user_name'], 'Alice')
        self.assertEqual(transcript['channel_id'], 'ch-a')
        self.assertEqual(transcript['sentence_id'], 0)
        self.assertTrue(transcript['is_update'])
        self.assertEqual(transcript['product_type'], 'phone')

        audio = next(p for name, p in media_events if name == 'audio')
        self.assertEqual(audio['user_id'], 'ch-b')
        self.assertEqual(audio['user_name'], 'pstn')
        self.assertEqual(audio['channel_id'], 'ch-b')
        self.assertEqual(audio['source'], 'caller')
        self.assertEqual(audio['buffer'], b'\x01\x02')

    def test_phone_hold_resume_and_transfer_events_are_emitted_by_name(self):
        conn = make_phone_conn()
        events = []

        async def send_all():
            for event in [
                {'event_code': RTMS_EVENT_CODES['ZP_CALL_HOLD'], 'timestamp': 1},
                {'event_code': RTMS_EVENT_CODES['ZP_CALL_RESUME'], 'timestamp': 2},
                {
                    'event_code': RTMS_EVENT_CODES['ZP_CALL_TRANSFER_COMPLETED'],
                    'transfer_type': 'MEETING',
                    'transfer_result': {'meeting_uuid': 'meeting-1'},
                    'timestamp': 3,
                },
            ]:
                await handle_signaling_message(
                    json.dumps({'msg_type': 6, 'event': event}),
                    'call-1', 'stream-1', FakeSocket(), conn, lambda n, p, *_: events.append((n, p)), 9, 'id', 'secret',
                )

        asyncio.run(send_all())

        names = [name for name, _ in events if name != 'event']
        self.assertEqual(names, ['phone_call_hold', 'phone_call_resume', 'phone_call_transfer_completed'])
        transfer = next(p for name, p in events if name == 'phone_call_transfer_completed')
        self.assertEqual(transfer['transferType'], 'MEETING')
        self.assertEqual(transfer['transferResult']['meeting_uuid'], 'meeting-1')

    def test_repeated_phone_call_rtms_started_refreshes_active_stream(self):
        async def run():
            with patch('rtms_manager.rtms_manager.connect_to_signaling_websocket', new_callable=AsyncMock) as mock_connect:
                manager = await RTMSManager.init({
                    **RTMSManager.PRESETS['PHONE'],
                    'credentials': {
                        'phone': {'client_id': 'cid', 'client_secret': 'csec', 'secret_token': 'tok'},
                    },
                })
                payload = {
                    'call_id': 'call-failover-1',
                    'rtms_stream_id': 'stream-failover-1',
                    'server_urls': 'wss://signal.zoom.us/ws',
                }
                manager.emit('phone.call_rtms_started', payload)
                await asyncio.sleep(0.02)
                self.assertEqual(mock_connect.await_count, 1)

                # Repeated start with identical stream_id and URLs must refresh Phone stream.
                manager.emit('phone.call_rtms_started', payload)
                await asyncio.sleep(0.02)
                self.assertEqual(mock_connect.await_count, 2)
                await manager.stop()

        asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
