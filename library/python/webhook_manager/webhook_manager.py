import hashlib
import hmac
import json
import os
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

try:
    from ..rtms_manager.utils.logger import FileLogger
except ImportError:
    from rtms_manager.utils.logger import FileLogger

DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300


def normalize_webhook_plain_token(token: Any) -> Optional[str]:
    """Zoom endpoint.url_validation tokens: 8-256 printable ASCII, no spaces."""
    if not isinstance(token, str) or not 8 <= len(token) <= 256:
        return None
    if any(not ('!' <= ch <= '~') for ch in token):
        return None
    return token


def build_url_validation_response(plain_token: Any, secret_token: str) -> Dict[str, str]:
    if not secret_token:
        raise ValueError('missing_webhook_secret_token')
    token = normalize_webhook_plain_token(plain_token)
    if not token:
        raise ValueError('invalid_plain_token')
    encrypted = hmac.new(
        secret_token.encode('utf-8'),
        token.encode('utf-8'),
        hashlib.sha256,
    ).hexdigest()
    return {'plainToken': token, 'encryptedToken': encrypted}


def _get_header(headers: Any, name: str) -> Optional[str]:
    if not headers:
        return None
    val = headers.get(name)
    if val is not None:
        return val
    lowered = name.lower()
    for key, header_val in headers.items():
        if isinstance(key, str) and key.lower() == lowered:
            return header_val
    return None


def _resolve_tolerance_seconds(tolerance_seconds: Optional[int]) -> int:
    raw = tolerance_seconds
    if raw is None:
        raw = os.environ.get('WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS')
    if raw is None:
        return DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
    try:
        parsed = int(raw)
        return parsed if parsed >= 0 else DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
    except (TypeError, ValueError):
        return DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS


def verify_zoom_webhook_request(
    raw_body: Any,
    headers: Any,
    secret_token: str,
    tolerance_seconds: Optional[int] = None,
) -> Dict[str, Any]:
    if not secret_token:
        return {'ok': False, 'reason': 'missing_webhook_secret_token'}
    signature = _get_header(headers, 'x-zm-signature')
    timestamp = _get_header(headers, 'x-zm-request-timestamp')
    if not signature:
        return {'ok': False, 'reason': 'missing_x_zm_signature'}
    if not timestamp:
        return {'ok': False, 'reason': 'missing_x_zm_request_timestamp'}
    if not isinstance(raw_body, (bytes, bytearray)):
        return {'ok': False, 'reason': 'missing_raw_body'}

    try:
        timestamp_seconds = int(timestamp)
    except (TypeError, ValueError):
        return {'ok': False, 'reason': 'invalid_x_zm_request_timestamp'}

    tolerance = _resolve_tolerance_seconds(tolerance_seconds)
    age_seconds = abs(int(time.time()) - timestamp_seconds)
    if tolerance > 0 and age_seconds > tolerance:
        return {'ok': False, 'reason': 'stale_x_zm_request_timestamp', 'age_seconds': age_seconds}

    message = b'v0:' + str(timestamp).encode('utf-8') + b':' + bytes(raw_body)
    expected = 'v0=' + hmac.new(
        secret_token.encode('utf-8'),
        message,
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(str(signature), expected):
        return {'ok': False, 'reason': 'invalid_x_zm_signature'}
    return {'ok': True, 'reason': 'verified', 'age_seconds': age_seconds}


class WebhookManager:
    def __init__(
        self,
        webhook_path: str = '/',
        zoom_secret_token: str = '',
        video_secret_token: str = '',
        webhook_timestamp_tolerance_seconds: Optional[int] = None,
        logger: Any = None,
        config: Optional[Dict[str, Any]] = None,
    ):
        cfg = config or {}
        self.config = cfg
        self.webhook_path = cfg.get('webhook_path', cfg.get('webhookPath', webhook_path))
        self.zoom_secret_token = cfg.get('zoom_secret_token', cfg.get('zoomSecretToken', zoom_secret_token))
        self.video_secret_token = cfg.get('video_secret_token', cfg.get('videoSecretToken', video_secret_token))
        configured_tolerance = cfg.get(
            'webhook_timestamp_tolerance_seconds',
            cfg.get('webhookTimestampToleranceSeconds', webhook_timestamp_tolerance_seconds),
        )
        self.webhook_timestamp_tolerance_seconds = _resolve_tolerance_seconds(configured_tolerance)
        self.logger = logger or FileLogger
        self._event_handlers: List[Callable[[str, Dict[str, Any]], None]] = []

    def on_event(self, handler: Callable[[str, Dict[str, Any]], None]):
        self._event_handlers.append(handler)

    def on(self, event_name: str, handler: Callable[[str, Dict[str, Any]], None]):
        if event_name == 'event':
            self.on_event(handler)

    def _emit_event(self, event: str, payload: Dict[str, Any]):
        for handler in list(self._event_handlers):
            try:
                handler(event, payload)
            except Exception as e:
                self.logger.error(f'[WebhookManager] Event handler error: {e}')

    def _select_secret_token(self, query_params: Optional[Dict[str, str]] = None) -> str:
        query_params = query_params or {}
        return self.video_secret_token if query_params.get('type') == 'video' else self.zoom_secret_token

    def validate_webhook(self, plain_token: str, secret_token: str) -> Dict[str, str]:
        return build_url_validation_response(plain_token, secret_token)

    def verify_delivery(self, raw_body: bytes, headers: Any, secret_token: str) -> Tuple[bool, str]:
        verdict = verify_zoom_webhook_request(
            raw_body,
            headers,
            secret_token,
            tolerance_seconds=self.webhook_timestamp_tolerance_seconds,
        )
        return bool(verdict['ok']), str(verdict['reason'])

    def process_webhook_event(
        self,
        event: Any,
        payload: Dict[str, Any],
        headers: Optional[Any] = None,
        body: Optional[Dict[str, Any]] = None,
    ):
        if headers is not None:
            self.logger.log(f'[WebhookManager] Webhook headers: {dict(headers)}')
        if body is not None:
            self.logger.log(f'[WebhookManager] Full webhook body: {body}')
        self.logger.log(f'[WebhookManager] Webhook event: {event}')

        if not isinstance(event, str) or not event:
            self.logger.warn('[WebhookManager] Ignoring webhook without a valid event name')
            return

        if (
            event in ('rtms.concurrency_limited', 'rtms.concurrency_near_limit', 'rtms.start_failed')
            or event.endswith('rtms_interrupted')
        ):
            self.logger.warn(f'[WebhookManager] Critical RTMS event received: {event}')
        elif event.endswith('rtms_started') or event.endswith('rtms_stopped'):
            self.logger.log(f'[WebhookManager] RTMS event received: {event}')

        self._emit_event(event, payload)

    def handle_webhook_with_status(
        self,
        body: Dict[str, Any],
        query_params: Optional[Dict[str, str]] = None,
        headers: Optional[Any] = None,
        defer_event: bool = False,
    ) -> Tuple[int, Optional[Dict[str, str]], Optional[Callable[[], None]]]:
        body = body if isinstance(body, dict) else {}
        event = body.get('event', '')
        payload = body.get('payload') or {}
        query_params = query_params or {}

        if event == 'endpoint.url_validation':
            self.logger.log(f'[WebhookManager] Webhook body: {body}')
            secret_token = self._select_secret_token(query_params)
            if not secret_token:
                return 500, {'error': 'webhook_secret_not_configured'}, None
            try:
                response = build_url_validation_response(payload.get('plainToken'), secret_token)
            except ValueError as err:
                return 400, {'error': str(err)}, None
            self.logger.log(f'[WebhookManager] Webhook validation response: {response}')
            return 200, response, None

        def dispatch():
            self.process_webhook_event(event, payload, headers=headers, body=body)

        if defer_event:
            return 200, None, dispatch

        dispatch()
        return 200, None, None

    def handle_webhook(
        self,
        body: Dict[str, Any],
        query_params: Optional[Dict[str, str]] = None,
    ) -> Optional[Dict[str, str]]:
        _status, response, _dispatch = self.handle_webhook_with_status(body, query_params=query_params)
        return response

    def setup_flask(self, app, rtms_manager=None):
        from flask import request, jsonify

        @app.route(self.webhook_path, methods=['POST'])
        def webhook_handler():
            raw_body = request.get_data(cache=True)
            body = request.get_json(silent=True) or {}
            query_params = dict(request.args)
            if body.get('event') != 'endpoint.url_validation':
                secret_token = self._select_secret_token(query_params)
                verified, reason = self.verify_delivery(raw_body, request.headers, secret_token)
                if not verified:
                    status = 500 if reason == 'missing_webhook_secret_token' else 401
                    self.logger.warn(f'[WebhookManager] Rejected webhook: {reason}')
                    return jsonify({'error': 'invalid_zoom_webhook'}), status

            status, response, _ = self.handle_webhook_with_status(
                body, query_params=query_params, headers=request.headers
            )
            if response is not None:
                return jsonify(response), status
            return '', status

        if rtms_manager:
            self.on_event(lambda event, payload: rtms_manager.handle_event(event, payload))

        self.logger.info(f'[WebhookManager] Flask webhook route set up at {self.webhook_path}')

    def setup_fastapi(self, app, rtms_manager=None):
        from fastapi import BackgroundTasks, Request
        from fastapi.responses import JSONResponse

        @app.post(self.webhook_path)
        async def webhook_handler(request: Request, background_tasks: BackgroundTasks):
            raw_body = await request.body()
            try:
                body = json.loads(raw_body or b'{}')
            except json.JSONDecodeError:
                body = {}
            query_params = dict(request.query_params)
            if body.get('event') != 'endpoint.url_validation':
                secret_token = self._select_secret_token(query_params)
                verified, reason = self.verify_delivery(raw_body, request.headers, secret_token)
                if not verified:
                    status = 500 if reason == 'missing_webhook_secret_token' else 401
                    self.logger.warn(f'[WebhookManager] Rejected webhook: {reason}')
                    return JSONResponse(content={'error': 'invalid_zoom_webhook'}, status_code=status)

            # Defer normal event processing until after the 200 response is sent.
            status, response, dispatch = self.handle_webhook_with_status(
                body,
                query_params=query_params,
                headers=request.headers,
                defer_event=True,
            )
            if dispatch is not None:
                background_tasks.add_task(dispatch)
            if response is not None:
                return JSONResponse(content=response, status_code=status)
            return JSONResponse(content={}, status_code=status)

        if rtms_manager:
            self.on_event(lambda event, payload: rtms_manager.handle_event(event, payload))

        self.logger.info(f'[WebhookManager] FastAPI webhook route set up at {self.webhook_path}')
