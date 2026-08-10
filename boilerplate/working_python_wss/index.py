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
import base64
import requests
import time

# Load environment variables
load_dotenv()

PORT = int(os.getenv("PORT", 3000))
LOG_LEVEL = os.getenv("LOG_LEVEL", "DEBUG")
ZOOM_SECRET_TOKEN = os.getenv("ZOOM_SECRET_TOKEN")
CLIENT_ID = os.getenv("ZOOM_CLIENT_ID")
CLIENT_SECRET = os.getenv("ZOOM_CLIENT_SECRET")

# Setup logging
logging.basicConfig(level=getattr(logging, LOG_LEVEL.upper(), logging.DEBUG))
logger = logging.getLogger(__name__)

app = Flask(__name__)
active_connections = {}
stream_locks_guard = threading.Lock()
stream_locks = {}
signaling_handshakes_in_flight = set()
duplicate_signal_retry_counts = {}
duplicate_signal_retry_timers = {}

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
            logger.error(f"[Signaling] Duplicate signal retries exhausted for stream {stream_id}")
            return

        duplicate_signal_retry_counts[stream_id] = retry_count + 1
        delay = INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_SEC * (2 ** retry_count)

        old_timer = duplicate_signal_retry_timers.get(stream_id)
        if old_timer:
            old_timer.cancel()

        def _retry():
            logger.warning(
                f"[Signaling] Duplicate signal request for stream {stream_id}, retrying in {delay:.1f}s"
            )
            connect_to_signaling_ws(meeting_uuid, stream_id, server_url)

        timer = threading.Timer(delay, _retry)
        timer.daemon = True
        duplicate_signal_retry_timers[stream_id] = timer
        timer.start()

def connect_to_media_ws(media_url, meeting_uuid, stream_id, signaling_socket):
    logger.info(f"Connecting to media WebSocket at {media_url}")

    def on_open(ws):
        signature = generate_signature(CLIENT_ID, meeting_uuid, stream_id, CLIENT_SECRET)
        handshake = {
            "msg_type": 3,
            "protocol_version": 1,
            "meeting_uuid": meeting_uuid,
            "rtms_stream_id": stream_id,
            "signature": signature,
            "media_type": 11,  # AUDIO | VIDEO | TRANSCRIPT
            "payload_encryption": False,
            "media_params": {
                "audio": {
                    "content_type": 2,
                    "sample_rate": 1,
                    "channel": 1,
                    "codec": 1,
                    "data_opt": 1,
                    "send_rate": 100
                },
                "video": {
                    "content_type": 3,
                    "codec": 7,
                    "resolution": 2,
                    "fps": 25
                },
                "transcript": {
                    "content_type": 5
                }
            }
        }
        ws.send(json.dumps(handshake))

    def on_message(ws, message):
        # logger.info(f"Received message from media WebSocket: {message}")
        try:
            msg = json.loads(message)
            msg_type = msg.get("msg_type")

            if msg_type == 4 and msg.get("status_code") == 0:
                signaling_socket.send(json.dumps({
                    "msg_type": 7,
                    "rtms_stream_id": stream_id
                }))
                logger.info("Media handshake successful, sent start streaming request")
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
            elif msg_type == 17:
                logger.info("Received TRANSCRIPT data")
                # Handle transcript data if needed
        except Exception as e:
            logger.error(f"Error processing media message: {e}")

    def on_error(ws, error):
        logger.error(f"Media socket error: {error}")

    def on_close(ws, close_status_code, close_msg):
        logger.info("Media socket closed")
        if meeting_uuid in active_connections:
            active_connections[meeting_uuid].pop("media", None)

    ws = websocket.WebSocketApp(media_url,
                                on_open=on_open,
                                on_message=on_message,
                                on_error=on_error,
                                on_close=on_close)
    active_connections[meeting_uuid]["media"] = ws
    threading.Thread(target=ws.run_forever, daemon=True).start()

def connect_to_signaling_ws(meeting_uuid, stream_id, server_url):
    logger.info(f"Connecting to signaling WebSocket for meeting {meeting_uuid}")

    stream_lock = get_stream_lock(stream_id)

    with stream_lock:
        if stream_id in signaling_handshakes_in_flight:
            logger.warning(f"[Signaling] Handshake already in flight for stream {stream_id}. Skipping duplicate connect.")
            return

        for conn_data in list(active_connections.values()):
            if conn_data.get("stream_id") == stream_id and conn_data.get("signaling"):
                logger.warning(f"[Signaling] Connection already exists for stream {stream_id}. Skipping duplicate connect.")
                return

        signaling_handshakes_in_flight.add(stream_id)

    def on_open(ws):
        signature = generate_signature(CLIENT_ID, meeting_uuid, stream_id, CLIENT_SECRET)
        handshake = {
            "msg_type": 1,
            "protocol_version": 1,
            "meeting_uuid": meeting_uuid,
            "rtms_stream_id": stream_id,
            "sequence": random.randint(0, int(1e9)),
            "signature": signature,
            "buffer_data": False
        }
        ws.send(json.dumps(handshake))
        logger.info("Sent handshake to signaling server")

    def on_message(ws, message):
        try:
            msg = json.loads(message)
            if msg.get("msg_type") == 2 and msg.get("status_code") == 0:
                with stream_lock:
                    signaling_handshakes_in_flight.discard(stream_id)
                clear_duplicate_retry_state(stream_id)
                media_url = msg.get("media_server", {}).get("server_urls", {}).get("all")
                if media_url:
                    connect_to_media_ws(media_url, meeting_uuid, stream_id, ws)
            elif msg.get("msg_type") == 2:
                with stream_lock:
                    signaling_handshakes_in_flight.discard(stream_id)
                if "duplicate signal request" in str(msg.get("reason") or "").lower():
                    schedule_duplicate_signal_retry(meeting_uuid, stream_id, server_url)
            elif msg.get("msg_type") == 12:
                ws.send(json.dumps({
                    "msg_type": 13,
                    "timestamp": msg["timestamp"]
                }))
                logger.info("Responded to Signaling KEEP_ALIVE_REQ")
        except Exception as e:
            logger.error(f"Error processing signaling message: {e}")

    def on_error(ws, error):
        with stream_lock:
            signaling_handshakes_in_flight.discard(stream_id)
        logger.error(f"Signaling socket error: {error}")

    def on_close(ws, close_status_code, close_msg):
        logger.info("Signaling socket closed")
        with stream_lock:
            signaling_handshakes_in_flight.discard(stream_id)
        if meeting_uuid in active_connections:
            active_connections[meeting_uuid].pop("signaling", None)

    ws = websocket.WebSocketApp(server_url,
                                on_open=on_open,
                                on_message=on_message,
                                on_error=on_error,
                                on_close=on_close)
    active_connections[meeting_uuid] = {"signaling": ws, "stream_id": stream_id}
    threading.Thread(target=ws.run_forever, daemon=True).start()

def get_zoom_access_token():
    url = "https://zoom.us/oauth/token?grant_type=client_credentials"
    credentials = f"{CLIENT_ID}:{CLIENT_SECRET}"
    encoded_credentials = base64.b64encode(credentials.encode()).decode()
    logger.debug(encoded_credentials)
    headers = {
        "Authorization": f"Basic {encoded_credentials}"
    }

    logger.debug("🔐 Requesting Zoom access token...")
    response = requests.post(url, headers=headers)

    logger.debug(f"🛰️ Token request sent to: {url}")
    logger.debug(f"📨 Response status: {response.status_code}")
    logger.debug(f"📨 Response body: {response.text}")

    if response.status_code == 200:
        token_data = response.json()
        logger.info("✅ Zoom access token received.")
        return token_data.get("access_token")
    else:
        logger.error(f"❌ Zoom token request failed: {response.status_code} {response.text}")
        return None



def start_zoom_event_websocket():
    logger.info("🔌 Initiating Zoom Event WebSocket connection...")

    base_ws_url = os.getenv("ZOOM_EVENT_WS_BASE")
    if not base_ws_url:
        logger.error("❌ Missing ZOOM_EVENT_WS_BASE in environment.")
        return

    access_token = get_zoom_access_token()
    if not access_token:
        logger.error("❌ Failed to obtain Zoom access token.")
        return

    full_ws_url = f"{base_ws_url}&access_token={access_token}"
    logger.debug(f"🔗 Full WebSocket URL: {full_ws_url}")

    def on_open(ws):
        logger.info("✅ WebSocket connection established.")
        logger.debug("🫀 Starting heartbeat thread every 30s...")

        def heartbeat():
            try:
                initial = {"module": "heartbeat"}
                ws.send(json.dumps(initial))
                logger.debug(f"💓 Sent initial heartbeat: {initial}")
            except Exception as e:
                logger.error(f"❌ Failed to send initial heartbeat: {e}")
                return

            while True:
                time.sleep(30)
                try:
                    ws.send(json.dumps({"module": "heartbeat"}))
                    logger.debug("💓 Heartbeat sent.")
                except Exception as e:
                    logger.error(f"❌ Heartbeat error: {e}")
                    break

        threading.Thread(target=heartbeat, daemon=True).start()

    def on_message(ws, message):
        logger.info("📥 Received message from Zoom Event WebSocket.")
        logger.debug(f"🔍 Raw Message:\n{message}")

        try:
            msg = json.loads(message)
            if msg.get("module") == "message":
                content = msg.get("content")
                if content:
                    event_data = json.loads(content)
                    event = event_data.get("event")
                    payload = event_data.get("payload", {})

                    logger.info(f"🧠 Parsed Event: {event}")
                    logger.debug(f"📦 Payload: {payload}")

                    if event == "meeting.rtms_started":
                        meeting_uuid = payload.get("meeting_uuid")
                        stream_id = payload.get("rtms_stream_id")
                        server_url = payload.get("server_urls")
                        logger.info(f"🚀 Triggering signaling WebSocket for {meeting_uuid}")
                        connect_to_signaling_ws(meeting_uuid, stream_id, server_url)

                    elif event == "meeting.rtms_stopped":
                        meeting_uuid = payload.get("meeting_uuid")
                        if meeting_uuid in active_connections:
                            stream_id = active_connections[meeting_uuid].get("stream_id")
                            if stream_id:
                                with get_stream_lock(stream_id):
                                    signaling_handshakes_in_flight.discard(stream_id)
                                clear_duplicate_retry_state(stream_id)
                            logger.info(f"🛑 Closing signaling for {meeting_uuid}")
                            for conn in active_connections[meeting_uuid].values():
                                try:
                                    conn.close()
                                except Exception:
                                    pass
                            del active_connections[meeting_uuid]

        except Exception as e:
            logger.error(f"❌ Error processing message: {e}")

    def on_error(ws, error):
        logger.error(f"⚠️ WebSocket Error: {error}")

    def on_close(ws, close_status_code, close_msg):
        logger.warning(f"🔌 WebSocket closed | Code: {close_status_code}, Message: {close_msg}")

    ws = websocket.WebSocketApp(
        full_ws_url,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close
    )

    threading.Thread(target=ws.run_forever, daemon=True).start()


if __name__ == '__main__':
    start_zoom_event_websocket()
    app.run(host='0.0.0.0', port=PORT)
