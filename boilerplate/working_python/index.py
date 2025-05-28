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

# Load environment variables
load_dotenv()

PORT = int(os.getenv("PORT", 3000))
WEBHOOK_PATH = os.getenv("WEBHOOK_PATH", "/webhook")
LOG_LEVEL = os.getenv("LOG_LEVEL", "DEBUG")
ZOOM_SECRET_TOKEN = os.getenv("ZOOM_SECRET_TOKEN")
CLIENT_ID = os.getenv("ZM_CLIENT_ID")
CLIENT_SECRET = os.getenv("ZM_CLIENT_SECRET")

# Setup logging
logging.basicConfig(level=getattr(logging, LOG_LEVEL.upper(), logging.DEBUG))
logger = logging.getLogger(__name__)

app = Flask(__name__)
active_connections = {}

def generate_signature(client_id, meeting_uuid, stream_id, client_secret):
    message = f"{client_id},{meeting_uuid},{stream_id}"
    signature = hmac.new(client_secret.encode(), message.encode(), hashlib.sha256).hexdigest()
    return signature

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
            "media_type": 32,
            "payload_encryption": False,
            "media_params": {
                "audio": {
                    "content_type": 1,
                    "sample_rate": 1,
                    "channel": 1,
                    "codec": 1,
                    "data_opt": 1,
                    "send_rate": 100
                },
                "video": {
                    "codec": 7,
                    "resolution": 2,
                    "fps": 25
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

    def on_open(ws):
        signature = generate_signature(CLIENT_ID, meeting_uuid, stream_id, CLIENT_SECRET)
        handshake = {
            "msg_type": 1,
            "protocol_version": 1,
            "meeting_uuid": meeting_uuid,
            "rtms_stream_id": stream_id,
            "sequence": random.randint(0, int(1e9)),
            "signature": signature
        }
        ws.send(json.dumps(handshake))
        logger.info("Sent handshake to signaling server")

    def on_message(ws, message):
        try:
            msg = json.loads(message)
            if msg.get("msg_type") == 2 and msg.get("status_code") == 0:
                media_url = msg.get("media_server", {}).get("server_urls", {}).get("all")
                if media_url:
                    connect_to_media_ws(media_url, meeting_uuid, stream_id, ws)
            elif msg.get("msg_type") == 12:
                ws.send(json.dumps({
                    "msg_type": 13,
                    "timestamp": msg["timestamp"]
                }))
                logger.info("Responded to Signaling KEEP_ALIVE_REQ")
        except Exception as e:
            logger.error(f"Error processing signaling message: {e}")

    def on_error(ws, error):
        logger.error(f"Signaling socket error: {error}")

    def on_close(ws, close_status_code, close_msg):
        logger.info("Signaling socket closed")
        if meeting_uuid in active_connections:
            active_connections[meeting_uuid].pop("signaling", None)

    ws = websocket.WebSocketApp(server_url,
                                on_open=on_open,
                                on_message=on_message,
                                on_error=on_error,
                                on_close=on_close)
    active_connections[meeting_uuid] = {"signaling": ws}
    threading.Thread(target=ws.run_forever, daemon=True).start()

@app.route(WEBHOOK_PATH, methods=['POST'])
def handle_webhook():
    data = request.get_json(force=True)
    logger.debug(f"Received POST request at {WEBHOOK_PATH} with data: {json.dumps(data, indent=2)}")

    event = data.get("event")
    payload = data.get("payload", {})

    if event == "endpoint.url_validation" and payload.get("plainToken"):
        hash_ = hmac.new(ZOOM_SECRET_TOKEN.encode(), payload["plainToken"].encode(), hashlib.sha256).hexdigest()
        return jsonify({"plainToken": payload["plainToken"], "encryptedToken": hash_})

    if event == "meeting.rtms_started":
        meeting_uuid = payload.get("meeting_uuid")
        stream_id = payload.get("rtms_stream_id")
        server_url = payload.get("server_urls")
        connect_to_signaling_ws(meeting_uuid, stream_id, server_url)

    if event == "meeting.rtms_stopped":
        meeting_uuid = payload.get("meeting_uuid")
        if meeting_uuid in active_connections:
            for conn in active_connections[meeting_uuid].values():
                try:
                    conn.close()
                except Exception:
                    pass
            del active_connections[meeting_uuid]

    return '', 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=PORT)
