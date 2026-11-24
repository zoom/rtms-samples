"""Hardening and parity tests: run with `python3 -m unittest discover -s tests` from library/python."""

import asyncio
import os
import sys
import time
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rtms_manager import (  # noqa: E402
    RTMSManager,
    RTMSConfigHelper,
    RTMSError,
    redact_secrets,
    get_rtms_session_state,
    get_rtms_stream_state,
    get_rtms_stop_reason,
    get_rtms_status_code,
)
from rtms_manager.media_socket import merge_media_config  # noqa: E402


class DelayedCloseSocket:
    def __init__(self, delay=0.02):
        self.delay = delay
        self.closed = False

    async def close(self):
        await asyncio.sleep(self.delay)
        self.closed = True


class HardeningAndParityTest(unittest.TestCase):
    def tearDown(self):
        RTMSManager.reset()

    def test_split_media_configuration_is_merged_instead_of_overwritten(self):
        audio_cfg = merge_media_config({}, {'audio': {'sample_rate': 1}}, 'audio')
        combined = merge_media_config(audio_cfg, {'video': {'fps': 25}}, 'video')
        self.assertEqual(combined, {'audio': {'sample_rate': 1}, 'video': {'fps': 25}})

    def test_config_merge_does_not_mutate_caller_input(self):
        raw = {
            'mediaTypes': 1,
            'credentials': {
                'meeting': {'clientId': 'client', 'zoomSecretToken': 'secret'},
                'video': {'videoClientId': 'v-client', 'videoClientSecret': 'v-secret'},
            },
        }
        snapshot = {
            'mediaTypes': 1,
            'credentials': {
                'meeting': {'clientId': 'client', 'zoomSecretToken': 'secret'},
                'video': {'videoClientId': 'v-client', 'videoClientSecret': 'v-secret'},
            },
        }
        config = RTMSConfigHelper.merge(raw)
        self.assertEqual(config.credentials.meeting.client_id, 'client')
        self.assertEqual(config.credentials.meeting.secret_token, 'secret')
        self.assertEqual(config.credentials.video_sdk.client_id, 'v-client')
        self.assertEqual(raw, snapshot)

    def test_config_merge_requires_explicit_concrete_media_and_rejects_unified(self):
        with self.assertRaisesRegex(ValueError, r'media_types is required'):
            RTMSConfigHelper.merge({})
        with self.assertRaisesRegex(ValueError, r'ALL value 32 is deprecated'):
            RTMSConfigHelper.merge({'media_types': 32})
        with self.assertRaisesRegex(ValueError, r'Unified RTMS media sockets'):
            RTMSConfigHelper.merge({'media_types': 1, 'media_socket_connection_mode': 'unified'})
        with self.assertRaisesRegex(ValueError, r'Unified RTMS media sockets'):
            RTMSConfigHelper.merge({'media_types': 1, 'use_unified_media_socket': True})
        self.assertEqual(RTMSConfigHelper.merge({'media_types': 1 | 8}).media_types, 9)

    def test_credentials_fallback_and_missing_error(self):
        config = RTMSConfigHelper.merge({
            'media_types': 1,
            'credentials': {'meeting': {'client_id': 'm-id', 'client_secret': 'm-sec'}},
        })
        # Empty phone credentials should fall back to meeting credentials.
        self.assertEqual(RTMSConfigHelper.get_credentials_for_product('phone', config).client_id, 'm-id')

        empty_config = RTMSConfigHelper.merge({'media_types': 1})
        with self.assertRaises(RTMSError) as ctx:
            RTMSConfigHelper.get_credentials_for_product('meeting', empty_config)
        self.assertEqual(ctx.exception.code, 'MISSING_CREDENTIALS')

    def test_rtms_error_and_lookup_helpers(self):
        err = RTMSError.from_zoom_status(48, meeting_id='m1', stream_id='s1')
        self.assertEqual(err.code, 'STATUS_MEDIA_DATA_TYPE_ALL_NOT_SUPPORTED')
        self.assertEqual(err.zoom_status, 48)
        self.assertIn('media_type', err.message.lower())
        self.assertIn('STATUS_MEDIA_DATA_TYPE_ALL_NOT_SUPPORTED', err.to_short_string())
        self.assertEqual(err.to_dict()['zoom_status'], 48)

        self.assertIn('OK', get_rtms_status_code(0))
        self.assertIn('INVALID_EVENT_CODE', get_rtms_status_code(57))
        self.assertIn('STARTED', get_rtms_session_state(2))
        self.assertIn('TERMINATED', get_rtms_stream_state(4))
        self.assertIn('STOP_BC_MEETING_ENDED', get_rtms_stop_reason(6))

    def test_redact_secrets_masks_sensitive_fields_without_mutating_input(self):
        payload = {
            'client_id': 'cid',
            'clientSecret': 'super-secret',
            'nested': {'signature': 'sig-value', 'safe': 'ok'},
            'items': [{'access_token': 'tok-123'}],
        }
        redacted = redact_secrets(payload)
        self.assertEqual(redacted['client_id'], '[REDACTED]')
        self.assertEqual(redacted['clientSecret'], '[REDACTED]')
        self.assertEqual(redacted['nested']['signature'], '[REDACTED]')
        self.assertEqual(redacted['nested']['safe'], 'ok')
        self.assertEqual(redacted['items'][0]['access_token'], '[REDACTED]')
        self.assertEqual(payload['clientSecret'], 'super-secret')

    def test_stream_history_lru_eviction_and_metadata_getters(self):
        async def run():
            manager = await RTMSManager.init({
                'media_types': 1,
                'max_stream_history_size': 2,
                'credentials': {'meeting': {'client_id': 'c', 'client_secret': 's'}},
            })
            now_ms = int(time.time() * 1000)
            RTMSManager.archive_stream('s-1', {
                'start_time': now_ms - 1000,
                'ping_rtt': 42,
                'media_config': {'audio': {'codec': 1}, 'video': {'fps': 25}, 'deskshare': {'fps': 1}, 'transcript': {'language': 9}, 'chat': {'content_type': 5}},
                'phone_call_info': {'host_channel_id': 'ch-1', 'participants': []},
            })
            RTMSManager.archive_stream('s-2', {'start_time': now_ms})
            RTMSManager.archive_stream('s-3', {'start_time': now_ms + 1000})

            # s-1 should be evicted when max_stream_history_size=2
            self.assertIsNone(RTMSManager.get_stream_metadata('s-1'))
            self.assertIsNotNone(RTMSManager.get_stream_metadata('s-2'))
            self.assertIsNotNone(RTMSManager.get_stream_metadata('s-3'))

            RTMSManager.archive_stream('s-4', {
                'start_time': now_ms,
                'ping_rtt': 18,
                'media_config': {'audio': {'codec': 1}, 'video': {'fps': 30}, 'deskshare': {'fps': 2}, 'transcript': {'language': 9}, 'chat': {'content_type': 5}},
                'phone_call_info': {'host_channel_id': 'ch-x', 'participants': []},
            })
            self.assertEqual(RTMSManager.get_audio_details('s-4'), {'codec': 1})
            self.assertEqual(RTMSManager.get_video_details('s-4'), {'fps': 30})
            self.assertEqual(RTMSManager.get_sharescreen_details('s-4'), {'fps': 2})
            self.assertEqual(RTMSManager.get_transcript_details('s-4'), {'language': 9})
            self.assertEqual(RTMSManager.get_chat_details('s-4'), {'content_type': 5})
            self.assertEqual(RTMSManager.get_ping_rtt('s-4'), 18)
            self.assertEqual(RTMSManager.get_stream_start_time('s-4'), now_ms)
            self.assertEqual(manager.get_phone_call_info('s-4')['host_channel_id'], 'ch-x')
            await manager.stop()

        asyncio.run(run())

    def test_manager_stop_cancels_reconnect_tasks_waits_for_close_and_is_idempotent(self):
        async def run():
            with patch('rtms_manager.rtms_manager.connect_to_signaling_websocket', new_callable=AsyncMock):
                manager = await RTMSManager.init({
                    'media_types': 1,
                    'credentials': {'meeting': {'client_id': 'c', 'client_secret': 's'}},
                })
                manager.emit('meeting.rtms_started', {
                    'meeting_uuid': 'm-stop',
                    'rtms_stream_id': 's-stop',
                    'server_urls': 'wss://signal.zoom.us/ws',
                })
                await asyncio.sleep(0.02)

                conn = manager._connections['s-stop']
                sig_sock = DelayedCloseSocket(0.02)
                aud_sock = DelayedCloseSocket(0.02)
                reconnect_task = asyncio.create_task(asyncio.sleep(10))
                conn.signaling = {'socket': sig_sock, 'state': 'ready'}
                conn.media = {'audio': {'socket': aud_sock, 'state': 'streaming', 'reconnect_task': reconnect_task}}

                started = time.monotonic()
                await asyncio.gather(manager.stop(), manager.stop())
                elapsed = time.monotonic() - started

                self.assertGreaterEqual(elapsed, 0.015)
                self.assertTrue(sig_sock.closed)
                self.assertTrue(aud_sock.closed)
                self.assertTrue(reconnect_task.cancelled())
                self.assertEqual(manager._state, 'STOPPED')
                self.assertEqual(len(manager.get_active_connections()), 0)

                # Archived end_time must be epoch milliseconds, not loop monotonic time.
                meta = RTMSManager.get_stream_metadata('s-stop')
                self.assertIsNotNone(meta)
                self.assertGreater(meta['end_time'], 1_700_000_000_000)

        asyncio.run(run())

    def test_rtms_interrupted_webhook_triggers_reconnect_stream(self):
        async def run():
            with patch('rtms_manager.rtms_manager.connect_to_signaling_websocket', new_callable=AsyncMock) as mock_connect:
                manager = await RTMSManager.init({
                    'media_types': 1,
                    'credentials': {'meeting': {'client_id': 'c', 'client_secret': 's'}},
                })
                manager.emit('meeting.rtms_started', {
                    'meeting_uuid': 'm-int',
                    'rtms_stream_id': 's-int',
                    'server_urls': 'wss://signal.zoom.us/ws',
                })
                await asyncio.sleep(0.02)
                self.assertEqual(mock_connect.await_count, 1)

                manager.emit('meeting.rtms_interrupted', {'rtms_stream_id': 's-int'})
                await asyncio.sleep(0.02)
                self.assertEqual(mock_connect.await_count, 2)
                await manager.stop()

        asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
