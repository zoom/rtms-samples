import os
import json
import hmac
import hashlib
import logging
import random
from flask import Flask, request, jsonify
from dotenv import load_dotenv
import websocket
import threading
from urllib.parse import urlparse

# Load environment variables
load_dotenv()

PORT = int(os.getenv("PORT", 3000))
WEBHOOK_PATH = os.getenv("WEBHOOK_PATH", "/webhook")
LOG_LEVEL = os.getenv("LOG_LEVEL", "DEBUG")
ZOOM_SECRET_TOKEN = os.getenv("ZOOM_SECRET_TOKEN")
CLIENT_ID = os.getenv("ZOOM_CLIENT_ID")
CLIENT_SECRET = os.getenv("ZOOM_CLIENT_SECRET")
MEDIA_TYPES_FLAG = int(os.getenv("MEDIA_TYPES_FLAG", "11"))
MEDIA_SOCKET_CONNECTION_MODE = os.getenv("MEDIA_SOCKET_CONNECTION_MODE", "split").strip().lower()

ALL_INDIVIDUAL_MEDIA_FLAGS = 1 | 2 | 4 | 8 | 16
MEDIA_DEFINITIONS = {
    "audio": 1,
    "video": 2,
    "deskshare": 4,
    "transcript": 8,
    "chat": 16,
}

if MEDIA_TYPES_FLAG != 32 and (
    MEDIA_TYPES_FLAG <= 0 or MEDIA_TYPES_FLAG & ~ALL_INDIVIDUAL_MEDIA_FLAGS
):
    raise ValueError("MEDIA_TYPES_FLAG must combine 1, 2, 4, 8, and 16, or be 32")
if MEDIA_SOCKET_CONNECTION_MODE not in {"split", "unified"}:
    raise ValueError("MEDIA_SOCKET_CONNECTION_MODE must be split or unified")
if MEDIA_SOCKET_CONNECTION_MODE == "unified" and MEDIA_TYPES_FLAG != 32:
    raise ValueError("Unified mode requires MEDIA_TYPES_FLAG=32")

# Setup logging
logging.basicConfig(level=getattr(logging, LOG_LEVEL.upper(), logging.DEBUG))
logger = logging.getLogger(__name__)
logging.getLogger("websocket").setLevel(logging.CRITICAL)

app = Flask(__name__)
active_connections = {}
stream_locks_guard = threading.Lock()
stream_locks = {}
signaling_handshakes_in_flight = set()
stream_attempt_counts = {}
duplicate_signal_retry_counts = {}
duplicate_signal_retry_timers = {}
signaling_send_locks = {}

MAX_DUPLICATE_SIGNAL_RETRIES = int(os.getenv("MAX_DUPLICATE_SIGNAL_RETRIES", "3"))
INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_SEC = float(os.getenv("INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_SEC", "1.5"))

def get_stream_lock(stream_id):
    with stream_locks_guard:
        if stream_id not in stream_locks:
            stream_locks[stream_id] = threading.Lock()
        return stream_locks[stream_id]

def generate_signature(client_id, meeting_uuid, stream_id, client_secret):
    message = f"{client_id},{meeting_uuid},{stream_id}"
    signature = hmac.new(client_secret.encode(), message.encode(), hashlib.sha256).hexdigest()
    return signature

def is_normal_close_error(error):
    error_text = str(error)
    return "Normal close" in error_text or "opcode=8" in error_text

def log_stream_snapshot(label, stream_id=None):
    active_keys = list(active_connections.keys())
    inflight_keys = list(signaling_handshakes_in_flight)
    logger.debug(f"[{label}] stream_id={stream_id} active_streams={active_keys} inflight={inflight_keys}")

def clear_duplicate_retry_state(stream_id):
    timer = duplicate_signal_retry_timers.pop(stream_id, None)
    if timer:
        timer.cancel()
    duplicate_signal_retry_counts.pop(stream_id, None)

def schedule_duplicate_signal_retry(meeting_uuid, stream_id, server_url):
    stream_lock = get_stream_lock(stream_id)
    with stream_lock:
        retry_count = duplicate_signal_retry_counts.get(stream_id, 0)
        if retry_count >= MAX_DUPLICATE_SIGNAL_RETRIES:
            logger.error(
                f"[Signaling] stream_id={stream_id} duplicate-signal retries exhausted "
                f"(max={MAX_DUPLICATE_SIGNAL_RETRIES})"
            )
            return

        duplicate_signal_retry_counts[stream_id] = retry_count + 1
        delay = INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_SEC * (2 ** retry_count)

        old_timer = duplicate_signal_retry_timers.get(stream_id)
        if old_timer:
            old_timer.cancel()

        def _retry():
            with stream_lock:
                if stream_id not in active_connections:
                    logger.info(f"[Signaling] stream_id={stream_id} retry cancelled (stream already cleaned up)")
                    return
            logger.warning(
                f"[Signaling] stream_id={stream_id} retrying after duplicate signal request "
                f"(attempt={retry_count + 1}, delay={delay:.1f}s)"
            )
            connect_to_signaling_ws(meeting_uuid, stream_id, server_url)

        timer = threading.Timer(delay, _retry)
        timer.daemon = True
        duplicate_signal_retry_timers[stream_id] = timer
        timer.start()

def media_params_for(media_name):
    params = {
        "audio": {
            "content_type": 2, "sample_rate": 1, "channel": 1,
            "codec": 1, "data_opt": 1, "send_rate": 100,
        },
        "video": {
            "content_type": 3, "codec": 7, "data_opt": 3,
            "resolution": 2, "fps": 25,
        },
        "deskshare": {"content_type": 3, "codec": 5, "resolution": 2, "fps": 1},
        "transcript": {"content_type": 5, "src_language": 9, "enable_lid": True},
        "chat": {"content_type": 5},
    }
    return params if media_name == "all" else {media_name: params[media_name]}

def send_signaling_message(stream_id, signaling_socket, payload):
    send_lock = signaling_send_locks.setdefault(stream_id, threading.Lock())
    with send_lock:
        signaling_socket.send(json.dumps(payload))

def connect_to_media_ws(media_url, meeting_uuid, stream_id, signaling_socket, media_name, media_type):
    logger.info(f"Connecting to {media_name} media WebSocket at {media_url}")
    parsed_media = urlparse(media_url)
    logger.debug(f"[Media] stream_id={stream_id} meeting_uuid={meeting_uuid} host={parsed_media.hostname} path={parsed_media.path}")

    def on_open(ws):
        signature = generate_signature(CLIENT_ID, meeting_uuid, stream_id, CLIENT_SECRET)
        handshake = {
            "msg_type": 3,
            "protocol_version": 1,
            "meeting_uuid": meeting_uuid,
            "rtms_stream_id": stream_id,
            "signature": signature,
            "media_type": media_type,
            "payload_encryption": False,
            "media_params": media_params_for(media_name),
        }
        ws.send(json.dumps(handshake))
        logger.debug(f"[Media] stream_id={stream_id} name={media_name} sent handshake media_type={media_type}")

    def on_message(ws, message):
        # logger.info(f"Received message from media WebSocket: {message}")
        try:
            msg = json.loads(message)
            msg_type = msg.get("msg_type")

            if msg_type == 4 and msg.get("status_code") == 0:
                send_signaling_message(stream_id, signaling_socket, {
                    "msg_type": 7,
                    "rtms_stream_id": stream_id
                })
                logger.info(f"{media_name} media handshake successful; CLIENT_READY_ACK sent")
                logger.debug(f"[Media] stream_id={stream_id} handshake_ok status_code=0")
            elif msg_type == 4:
                logger.warning(f"[Media] stream_id={stream_id} handshake_failed status_code={msg.get('status_code')} reason={msg.get('reason')}")
            elif msg_type == 12:
                ws.send(json.dumps({
                    "msg_type": 13,
                    "timestamp": msg["timestamp"]
                }))
                logger.info("Responded to Media KEEP_ALIVE_REQ")
            elif msg_type == 14:
                logger.info("Received AUDIO data")
                # Handle audio data if needed
            elif msg_type == 15:
                logger.info("Received VIDEO data")
                # Handle video data if needed
            elif msg_type == 16:
                logger.info("Received SCREEN SHARE data")
            elif msg_type == 17:
                logger.info("Received TRANSCRIPT data")
                # Handle transcript data if needed
            elif msg_type == 18:
                logger.info("Received CHAT data")
        except Exception as e:
            logger.error(f"Error processing media message: {e}")

    def on_error(ws, error):
        if is_normal_close_error(error):
            logger.info(f"Media socket normal close: stream_id={stream_id} error={error}")
        else:
            logger.error(f"Media socket error: stream_id={stream_id} error_type={type(error).__name__} error={error}")

    def on_close(ws, close_status_code, close_msg):
        logger.info(f"Media socket closed stream_id={stream_id} close_code={close_status_code} close_msg={close_msg}")
        if stream_id in active_connections:
            active_connections[stream_id].pop(media_name, None)
        log_stream_snapshot("media_close", stream_id)

    ws = websocket.WebSocketApp(media_url,
                                on_open=on_open,
                                on_message=on_message,
                                on_error=on_error,
                                on_close=on_close)
    active_connections[stream_id][media_name] = ws
    threading.Thread(target=ws.run_forever, daemon=True).start()

def connect_to_signaling_ws(meeting_uuid, stream_id, server_url):
    logger.info(f"Connecting to signaling WebSocket for meeting {meeting_uuid}")
    parsed_signaling = urlparse(server_url)
    attempt = stream_attempt_counts.get(stream_id, 0) + 1
    stream_attempt_counts[stream_id] = attempt
    logger.info(
        f"[Signaling] start stream_id={stream_id} meeting_uuid={meeting_uuid} attempt={attempt} "
        f"host={parsed_signaling.hostname}"
    )
    log_stream_snapshot("before_signaling_connect", stream_id)

    stream_lock = get_stream_lock(stream_id)

    with stream_lock:
        if stream_id in signaling_handshakes_in_flight:
            logger.warning(f"[Signaling] Handshake already in flight for stream {stream_id}. Skipping duplicate connect.")
            return

        existing_conn = active_connections.get(stream_id)
        if existing_conn and existing_conn.get("signaling"):
            logger.warning(f"[Signaling] Connection already exists for stream {stream_id}. Skipping duplicate connect.")
            return

        signaling_handshakes_in_flight.add(stream_id)
        logger.debug(f"[Signaling] stream_id={stream_id} lock_acquired handshake_inflight=True")

    def on_open(ws):
        signature = generate_signature(CLIENT_ID, meeting_uuid, stream_id, CLIENT_SECRET)
        sequence = random.randint(0, int(1e9))
        handshake = {
            "msg_type": 1,
            "protocol_version": 1,
            "meeting_uuid": meeting_uuid,
            "rtms_stream_id": stream_id,
            "sequence": sequence,
            "signature": signature,
            "buffer_data": False
        }
        ws.send(json.dumps(handshake))
        logger.info(f"Sent handshake to signaling server stream_id={stream_id} sequence={sequence}")

    def on_message(ws, message):
        try:
            msg = json.loads(message)
            if msg.get("msg_type") == 2 and msg.get("status_code") == 0:
                with stream_lock:
                    signaling_handshakes_in_flight.discard(stream_id)
                clear_duplicate_retry_state(stream_id)
                logger.info(
                    f"[Signaling] handshake_ok stream_id={stream_id} status_code=0 "
                    f"mode={MEDIA_SOCKET_CONNECTION_MODE} media_types={MEDIA_TYPES_FLAG}"
                )
                media_urls = msg.get("media_server", {}).get("server_urls", {})
                if MEDIA_SOCKET_CONNECTION_MODE == "unified":
                    media_url = media_urls.get("all")
                    if media_url:
                        connect_to_media_ws(media_url, meeting_uuid, stream_id, ws, "all", 32)
                    else:
                        logger.error(f"[Signaling] stream_id={stream_id} missing server_urls.all")
                else:
                    requested_flags = ALL_INDIVIDUAL_MEDIA_FLAGS if MEDIA_TYPES_FLAG == 32 else MEDIA_TYPES_FLAG
                    for media_name, media_type in MEDIA_DEFINITIONS.items():
                        if requested_flags & media_type:
                            media_url = media_urls.get(media_name)
                            if media_url:
                                connect_to_media_ws(
                                    media_url, meeting_uuid, stream_id, ws, media_name, media_type
                                )
                            else:
                                logger.warning(
                                    f"[Signaling] stream_id={stream_id} missing server_urls.{media_name}"
                                )
            elif msg.get("msg_type") == 2:
                with stream_lock:
                    signaling_handshakes_in_flight.discard(stream_id)
                status_code = msg.get("status_code")
                reason = str(msg.get("reason") or "")
                logger.warning(
                    f"[Signaling] handshake_failed stream_id={stream_id} status_code={msg.get('status_code')} "
                    f"reason={msg.get('reason')} raw={msg}"
                )
                if "duplicate signal request" in reason.lower():
                    schedule_duplicate_signal_retry(meeting_uuid, stream_id, server_url)
            elif msg.get("msg_type") == 12:
                send_signaling_message(stream_id, ws, {
                    "msg_type": 13,
                    "timestamp": msg["timestamp"]
                })
                logger.info("Responded to Signaling KEEP_ALIVE_REQ")
            else:
                logger.debug(f"[Signaling] stream_id={stream_id} msg_type={msg.get('msg_type')} payload={msg}")
        except Exception as e:
            logger.error(f"Error processing signaling message stream_id={stream_id}: {e}")

    def on_error(ws, error):
        with stream_lock:
            signaling_handshakes_in_flight.discard(stream_id)
        log_stream_snapshot("signaling_error", stream_id)
        if is_normal_close_error(error):
            logger.info(f"Signaling socket normal close: stream_id={stream_id} error={error}")
        else:
            logger.error(f"Signaling socket error: stream_id={stream_id} error_type={type(error).__name__} error={error}")

    def on_close(ws, close_status_code, close_msg):
        logger.info(
            f"Signaling socket closed stream_id={stream_id} meeting_uuid={meeting_uuid} "
            f"close_code={close_status_code} close_msg={close_msg}"
        )
        with stream_lock:
            signaling_handshakes_in_flight.discard(stream_id)
        if stream_id in active_connections:
            active_connections[stream_id].pop("signaling", None)
        log_stream_snapshot("signaling_close", stream_id)

    ws = websocket.WebSocketApp(server_url,
                                on_open=on_open,
                                on_message=on_message,
                                on_error=on_error,
                                on_close=on_close)
    active_connections[stream_id] = {
        "signaling": ws,
        "stream_id": stream_id,
        "meeting_uuid": meeting_uuid,
    }
    threading.Thread(target=ws.run_forever, daemon=True).start()

@app.route(WEBHOOK_PATH, methods=['POST'])
def handle_webhook():
    data = request.get_json(force=True)
    event = data.get("event")
    payload = data.get("payload", {})

    if event == "endpoint.url_validation" and payload.get("plainToken"):
        hash_ = hmac.new(ZOOM_SECRET_TOKEN.encode(), payload["plainToken"].encode(), hashlib.sha256).hexdigest()
        return jsonify({"plainToken": payload["plainToken"], "encryptedToken": hash_})

    # Flask invokes this callback after the HTTP response iterable is closed.
    response = app.response_class(status=200)
    response.call_on_close(
        lambda: threading.Thread(target=process_webhook_after_ack, args=(data,), daemon=True).start()
    )
    return response

def process_webhook_after_ack(data):
    logger.debug(f"Acknowledged POST request at {WEBHOOK_PATH} with data: {json.dumps(data, indent=2)}")
    event = data.get("event")
    payload = data.get("payload", {})

    if event == "meeting.rtms_started":
        meeting_uuid = payload.get("meeting_uuid")
        stream_id = payload.get("rtms_stream_id")
        server_url = payload.get("server_urls")
        logger.info(
            f"[Webhook] meeting.rtms_started meeting_uuid={meeting_uuid} stream_id={stream_id} "
            f"event_ts={data.get('event_ts')} host={urlparse(server_url).hostname if server_url else None}"
        )
        log_stream_snapshot("webhook_started_before_connect", stream_id)
        connect_to_signaling_ws(meeting_uuid, stream_id, server_url)

    if event == "meeting.rtms_stopped":
        stream_id = payload.get("rtms_stream_id")
        logger.info(
            f"[Webhook] meeting.rtms_stopped meeting_uuid={payload.get('meeting_uuid')} stream_id={stream_id} "
            f"stop_reason={payload.get('stop_reason')} event_ts={data.get('event_ts')}"
        )
        if stream_id in active_connections:
            with get_stream_lock(stream_id):
                signaling_handshakes_in_flight.discard(stream_id)
            clear_duplicate_retry_state(stream_id)
            for conn in active_connections[stream_id].values():
                try:
                    conn.close()
                except Exception:
                    pass
            del active_connections[stream_id]
            signaling_send_locks.pop(stream_id, None)
        else:
            meeting_uuid = payload.get("meeting_uuid")
            stream_ids = [sid for sid, conn in active_connections.items() if conn.get("meeting_uuid") == meeting_uuid]
            for sid in stream_ids:
                with get_stream_lock(sid):
                    signaling_handshakes_in_flight.discard(sid)
                clear_duplicate_retry_state(sid)
                for conn in active_connections[sid].values():
                    try:
                        conn.close()
                    except Exception:
                        pass
                del active_connections[sid]
                signaling_send_locks.pop(sid, None)
        log_stream_snapshot("webhook_stopped_after_cleanup", stream_id)

if __name__ == '__main__':
    logger.info(
        f"RTMS media configuration: mode={MEDIA_SOCKET_CONNECTION_MODE} media_types={MEDIA_TYPES_FLAG}"
    )
    app.run(host='0.0.0.0', port=PORT)
