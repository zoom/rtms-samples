import hmac
import hashlib
import time
from typing import Callable, Dict, Any, Optional, List

from ..rtms_manager.utils.logger import FileLogger


class WebhookManager:
    def __init__(
        self,
        webhook_path: str = '/',
        zoom_secret_token: str = '',
        video_secret_token: str = '',
        webhook_timestamp_tolerance_seconds: int = 300
    ):
        self.webhook_path = webhook_path
        self.zoom_secret_token = zoom_secret_token
        self.video_secret_token = video_secret_token
        self.webhook_timestamp_tolerance_seconds = webhook_timestamp_tolerance_seconds
        self._event_handlers: List[Callable[[str, Dict[str, Any]], None]] = []

    def on_event(self, handler: Callable[[str, Dict[str, Any]], None]):
        self._event_handlers.append(handler)

    def _emit_event(self, event: str, payload: Dict[str, Any]):
        for handler in self._event_handlers:
            try:
                handler(event, payload)
            except Exception as e:
                FileLogger.error(f'[WebhookManager] Event handler error: {e}')

    def validate_webhook(self, plain_token: str, secret_token: str) -> Dict[str, str]:
        encrypted = hmac.new(
            secret_token.encode('utf-8'),
            plain_token.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        return {'plainToken': plain_token, 'encryptedToken': encrypted}

    def verify_delivery(self, raw_body: bytes, headers: Any, secret_token: str) -> tuple[bool, str]:
        if not secret_token:
            return False, 'missing_webhook_secret_token'
        signature = headers.get('x-zm-signature')
        timestamp = headers.get('x-zm-request-timestamp')
        if not signature:
            return False, 'missing_x_zm_signature'
        if not timestamp:
            return False, 'missing_x_zm_request_timestamp'
        try:
            timestamp_seconds = int(timestamp)
        except (TypeError, ValueError):
            return False, 'invalid_x_zm_request_timestamp'
        if (
            self.webhook_timestamp_tolerance_seconds > 0 and
            abs(int(time.time()) - timestamp_seconds) > self.webhook_timestamp_tolerance_seconds
        ):
            return False, 'stale_x_zm_request_timestamp'

        message = b'v0:' + str(timestamp).encode('utf-8') + b':' + raw_body
        expected = 'v0=' + hmac.new(
            secret_token.encode('utf-8'), message, hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(str(signature), expected):
            return False, 'invalid_x_zm_signature'
        return True, 'verified'

    def handle_webhook(self, body: Dict[str, Any], query_params: Optional[Dict[str, str]] = None) -> Optional[Dict[str, str]]:
        FileLogger.log(f'[WebhookManager] Webhook body: {body}')
        
        event = body.get('event', '')
        payload = body.get('payload', {})

        if event in ('rtms.concurrency_limited', 'rtms.concurrency_near_limit', 
                     'rtms.start_failed') or event.endswith('rtms_interrupted'):
            FileLogger.warn(f'[WebhookManager] Critical RTMS event: {event}')

        if event == 'endpoint.url_validation' and payload.get('plainToken'):
            query_params = query_params or {}
            is_video = query_params.get('type') == 'video'
            secret_token = self.video_secret_token if is_video else self.zoom_secret_token
            response = self.validate_webhook(payload['plainToken'], secret_token)
            FileLogger.log(f'[WebhookManager] Webhook validation response: {response}')
            return response

        self._emit_event(event, payload)
        return None

    def setup_flask(self, app, rtms_manager=None):
        from flask import request, jsonify

        @app.route(self.webhook_path, methods=['POST'])
        def webhook_handler():
            raw_body = request.get_data(cache=True)
            body = request.get_json() or {}
            query_params = dict(request.args)
            if body.get('event') != 'endpoint.url_validation':
                secret_token = self.video_secret_token if query_params.get('type') == 'video' else self.zoom_secret_token
                verified, reason = self.verify_delivery(raw_body, request.headers, secret_token)
                if not verified:
                    status = 500 if reason == 'missing_webhook_secret_token' else 401
                    FileLogger.warn(f'[WebhookManager] Rejected webhook: {reason}')
                    return jsonify({'error': 'invalid_zoom_webhook'}), status
            
            response = self.handle_webhook(body, query_params)
            if response:
                return jsonify(response)
            
            return '', 200

        if rtms_manager:
            self.on_event(lambda event, payload: rtms_manager.handle_event(event, payload))

        FileLogger.info(f'[WebhookManager] Flask webhook route set up at {self.webhook_path}')

    def setup_fastapi(self, app, rtms_manager=None):
        from fastapi import Request
        from fastapi.responses import JSONResponse

        @app.post(self.webhook_path)
        async def webhook_handler(request: Request):
            raw_body = await request.body()
            import json
            body = json.loads(raw_body or b'{}')
            query_params = dict(request.query_params)
            if body.get('event') != 'endpoint.url_validation':
                secret_token = self.video_secret_token if query_params.get('type') == 'video' else self.zoom_secret_token
                verified, reason = self.verify_delivery(raw_body, request.headers, secret_token)
                if not verified:
                    status = 500 if reason == 'missing_webhook_secret_token' else 401
                    FileLogger.warn(f'[WebhookManager] Rejected webhook: {reason}')
                    return JSONResponse(content={'error': 'invalid_zoom_webhook'}, status_code=status)
            
            response = self.handle_webhook(body, query_params)
            if response:
                return JSONResponse(content=response)
            
            return JSONResponse(content={}, status_code=200)

        if rtms_manager:
            self.on_event(lambda event, payload: rtms_manager.handle_event(event, payload))

        FileLogger.info(f'[WebhookManager] FastAPI webhook route set up at {self.webhook_path}')
