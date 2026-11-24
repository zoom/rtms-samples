"""FrontendManager, FrontendWssManager, and WebhookManager tests."""

import asyncio
import hashlib
import hmac
import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from frontend_manager import FrontendClient, FrontendManager, FrontendWssManager  # noqa: E402
from webhook_manager import (  # noqa: E402
    WebhookManager,
    build_url_validation_response,
    normalize_webhook_plain_token,
    verify_zoom_webhook_request,
)


class SilentLogger:
    def log(self, *_args, **_kwargs):
        pass

    def info(self, *_args, **_kwargs):
        pass

    def warn(self, *_args, **_kwargs):
        pass

    def error(self, *_args, **_kwargs):
        pass


class FakeWs:
    def __init__(self, incoming=None):
        self.incoming = list(incoming or [])
        self.sent = []
        self.closed = False

    def __aiter__(self):
        return self._iter()

    async def _iter(self):
        for item in self.incoming:
            yield item

    async def send(self, message):
        self.sent.append(message)

    async def close(self, *_args, **_kwargs):
        self.closed = True


class FrontendAndWebhookParityTest(unittest.TestCase):
    def test_frontend_registration_fails_closed_without_authorizer(self):
        manager = FrontendWssManager(logger=SilentLogger())
        result = asyncio.run(manager.validate_registration({
            'meetingUUID': 'meeting-1',
            'userID': 'user-1',
        }))
        self.assertEqual(result, {'authorized': False})

    def test_frontend_registration_uses_canonical_identity_from_authorizer(self):
        async def authorize(ctx):
            if ctx.get('token') == 'valid':
                return {
                    'authorized': True,
                    'meetingUUID': 'verified-meeting',
                    'userID': 'verified-user',
                }
            return False

        manager = FrontendWssManager(authorize_registration=authorize, logger=SilentLogger())
        result = asyncio.run(manager.validate_registration({
            'meetingUUID': 'untrusted-meeting',
            'userID': 'untrusted-user',
            'token': 'valid',
        }))
        self.assertTrue(result['authorized'])
        self.assertEqual(result['meetingUUID'], 'verified-meeting')
        self.assertEqual(result['userID'], 'verified-user')

    def test_frontend_broadcast_excludes_unregistered_clients(self):
        async def run():
            manager = FrontendWssManager(logger=SilentLogger())
            unregistered_ws = FakeWs()
            registered_ws = FakeWs()
            manager.clients.add(FrontendClient(websocket=unregistered_ws))
            manager.clients.add(FrontendClient(
                websocket=registered_ws,
                meeting_uuid='meeting-1',
                user_id='user-1',
                registered=True,
            ))

            await manager._broadcast_async({'type': 'test'})
            self.assertEqual(len(unregistered_ws.sent), 0)
            self.assertEqual(len(registered_ws.sent), 1)

            await manager._broadcast_to_meeting_async('meeting-1', {'type': 'meeting-msg'})
            self.assertEqual(len(unregistered_ws.sent), 0)
            self.assertEqual(len(registered_ws.sent), 2)

            await manager._broadcast_to_user_async('meeting-1', 'user-1', {'type': 'user-msg'})
            self.assertEqual(len(registered_ws.sent), 3)

        asyncio.run(run())

    def test_frontend_connection_rejects_unauthorized_register(self):
        async def run():
            manager = FrontendWssManager(logger=SilentLogger())
            ws = FakeWs([json.dumps({'type': 'register', 'meetingUUID': 'm1', 'userID': 'u1'})])
            await manager.handle_connection(ws, '/ws')
            self.assertTrue(ws.closed)
            decoded = [json.loads(m) for m in ws.sent]
            self.assertTrue(any(m.get('type') == 'error' and 'unauthorized' in m.get('message', '') for m in decoded))

        asyncio.run(run())

    def test_frontend_manager_resolves_websocket_url(self):
        fm = FrontendManager(frontend_wss_path='/ws', port=3000, logger=SilentLogger())
        self.assertEqual(fm.resolve_websocket_url(host='localhost:3000', is_secure=False), 'ws://localhost:3000/ws')
        self.assertEqual(fm.resolve_websocket_url(host='localhost:3000', forwarded_proto='https'), 'wss://localhost:3000/ws')
        self.assertEqual(fm.resolve_websocket_url(host='app.example.com', is_secure=False), 'wss://app.example.com/ws')

        fm_explicit = FrontendManager(frontend_wss_url='wss://custom.example.com/socket', logger=SilentLogger())
        self.assertEqual(fm_explicit.resolve_websocket_url(host='localhost:3000'), 'wss://custom.example.com/socket')

    def test_webhook_plain_token_validation_and_url_validation_response(self):
        self.assertEqual(normalize_webhook_plain_token('abc123XYZ'), 'abc123XYZ')
        self.assertEqual(normalize_webhook_plain_token('v0:123:body'), 'v0:123:body')
        self.assertIsNone(normalize_webhook_plain_token(None))
        self.assertIsNone(normalize_webhook_plain_token(123))
        self.assertIsNone(normalize_webhook_plain_token('short'))
        self.assertIsNone(normalize_webhook_plain_token('x' * 257))
        self.assertIsNone(normalize_webhook_plain_token('has space'))

        res = build_url_validation_response('abc123XYZ', 'test-secret')
        self.assertEqual(res['plainToken'], 'abc123XYZ')
        self.assertRegex(res['encryptedToken'], r'^[a-f0-9]{64}$')

        with self.assertRaisesRegex(ValueError, 'invalid_plain_token'):
            build_url_validation_response('bad token', 'test-secret')
        with self.assertRaisesRegex(ValueError, 'missing_webhook_secret_token'):
            build_url_validation_response('abc123XYZ', '')

    def test_webhook_signature_verification_and_deferred_dispatch(self):
        secret = 'test-secret'
        ts = str(int(time.time()))
        body_dict = {'event': 'meeting.rtms_started', 'payload': {'rtms_stream_id': 'stream-1'}}
        raw_body = json.dumps(body_dict).encode('utf-8')
        sig = 'v0=' + hmac.new(
            secret.encode('utf-8'),
            f'v0:{ts}:'.encode('utf-8') + raw_body,
            hashlib.sha256,
        ).hexdigest()

        verdict = verify_zoom_webhook_request(
            raw_body,
            {'X-Zm-Signature': sig, 'X-Zm-Request-Timestamp': ts},
            secret,
        )
        self.assertTrue(verdict['ok'])

        bad_sig = verify_zoom_webhook_request(
            raw_body,
            {'x-zm-signature': 'v0=deadbeef', 'x-zm-request-timestamp': ts},
            secret,
        )
        self.assertFalse(bad_sig['ok'])
        self.assertEqual(bad_sig['reason'], 'invalid_x_zm_signature')

        stale_ts = str(int(time.time()) - 301)
        stale_sig = 'v0=' + hmac.new(
            secret.encode('utf-8'),
            f'v0:{stale_ts}:'.encode('utf-8') + raw_body,
            hashlib.sha256,
        ).hexdigest()
        stale = verify_zoom_webhook_request(
            raw_body,
            {'x-zm-signature': stale_sig, 'x-zm-request-timestamp': stale_ts},
            secret,
        )
        self.assertFalse(stale['ok'])
        self.assertEqual(stale['reason'], 'stale_x_zm_request_timestamp')

        # URL validation returns 400 on invalid token, 500 on missing secret, 200 on valid token
        wm_no_secret = WebhookManager(logger=SilentLogger())
        status, resp, _ = wm_no_secret.handle_webhook_with_status({
            'event': 'endpoint.url_validation',
            'payload': {'plainToken': 'abc123XYZ'},
        })
        self.assertEqual(status, 500)
        self.assertEqual(resp, {'error': 'webhook_secret_not_configured'})

        wm = WebhookManager(zoom_secret_token=secret, logger=SilentLogger())
        status, resp, _ = wm.handle_webhook_with_status({
            'event': 'endpoint.url_validation',
            'payload': {'plainToken': 'bad'},
        })
        self.assertEqual(status, 400)
        self.assertEqual(resp, {'error': 'invalid_plain_token'})

        # Deferred event dispatch acknowledges before emitting
        emitted = []
        wm.on('event', lambda evt, pl: emitted.append((evt, pl)))
        status, resp, dispatch = wm.handle_webhook_with_status(body_dict, defer_event=True)
        self.assertEqual(status, 200)
        self.assertIsNone(resp)
        self.assertEqual(emitted, [])
        self.assertIsNotNone(dispatch)
        dispatch()
        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0][0], 'meeting.rtms_started')


if __name__ == '__main__':
    unittest.main()
