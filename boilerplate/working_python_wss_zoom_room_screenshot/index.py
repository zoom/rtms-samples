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
from pathlib import Path

# Load environment variables
load_dotenv()

PORT = int(os.getenv("PORT", 3000))
LOG_LEVEL = os.getenv("LOG_LEVEL", "DEBUG")
ZOOM_SECRET_TOKEN = os.getenv("ZOOM_SECRET_TOKEN")
CLIENT_ID = os.getenv("ZM_CLIENT_ID")
CLIENT_SECRET = os.getenv("ZM_CLIENT_SECRET")
ACCOUNT_ID = os.getenv("ZOOM_ACCOUNT_ID")
S2S_CLIENT_ID = os.getenv("S2S_ZM_CLIENT_ID")
S2S_CLIENT_SECRET = os.getenv("S2S_ZM_CLIENT_SECRET")
MEETING_NUMBER = os.getenv("ZOOM_MEETING_NUMBER")
MEETING_PASSCODE = os.getenv("ZOOM_MEETING_PASSCODE")

# Setup logging
logging.basicConfig(level=getattr(logging, LOG_LEVEL.upper(), logging.DEBUG))
logger = logging.getLogger(__name__)

app = Flask(__name__)
active_connections = {}

RETRY_FILE = 'retry_rooms.json'
MAX_FILES_PER_USER = 3
user_frame_counters = {}
retry_rooms = []


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
                    "codec": 5, #JPG
                     # "data_opt":3, # VIDEO_SINGLE_ACTIVE_STREAM
                    "resolution": 2, #720p, use 3 for #1080p
                    "fps": 5
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
                logger.info("Starting Room Joiners")

            elif msg_type == 12:
                ws.send(json.dumps({
                    "msg_type": 13,
                    "timestamp": msg["timestamp"]
                }))
                logger.info("Responded to Media KEEP_ALIVE_REQ")
            elif msg_type == 14:
                # logger.info("Audio")
                pass
            elif msg_type == 15:
                # logger.info("Video")

                content = msg.get("content", {})

                video_data_b64 = content.get("data")
                timestamp = content.get("timestamp")
                user_name = content.get("user_name")
                user_id = str(content.get("user_id"))
            
                logger.debug(f"🧾 Extracted fields — user_name: '{user_name}', user_id: '{user_id}', timestamp: '{timestamp}'")
                logger.debug(f"📏 video_data_b64 is None: {video_data_b64 is None}, type: {type(video_data_b64)}")
                try:
                    logger.debug(f"📦 Decoding video frame for user {user_name} ({user_id}) at {timestamp}")
                    buffer = base64.b64decode(video_data_b64)
                    save_video_frame(buffer, user_id, timestamp, user_name)
                except Exception as e:
                    logger.error(f"❌ Failed to process video data for {user_id}: {e}")
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

def load_retry_list():
    global retry_rooms
    if os.path.exists(RETRY_FILE):
        with open(RETRY_FILE, 'r') as f:
            retry_rooms = json.load(f)
            logger.info(f"✅ Loaded {len(retry_rooms)} rooms from retry list.")
    else:
        logger.info("ℹ️ No retry file found. Starting fresh.")


def save_retry_list():
    with open(RETRY_FILE, 'w') as f:
        json.dump(retry_rooms, f, indent=2)
        logger.info(f"💾 Saved {len(retry_rooms)} rooms to retry list.")


def remove_room_from_retry_list(room_id):
    global retry_rooms
    before = len(retry_rooms)
    retry_rooms = [room for room in retry_rooms if room['id'] != room_id]
    after = len(retry_rooms)
    logger.debug(f"🧹 Removed room {room_id} from retry list. ({before} -> {after})")


def get_zoom_api_token():
    logger.debug("🔐 Requesting Zoom API token...")
    credentials = f"{S2S_CLIENT_ID}:{S2S_CLIENT_SECRET}"
    encoded = base64.b64encode(credentials.encode()).decode()
    url = f"https://zoom.us/oauth/token?grant_type=account_credentials&account_id={ACCOUNT_ID}"
    headers = {"Authorization": f"Basic {encoded}"}
    res = requests.post(url, headers=headers)
    res.raise_for_status()
    token = res.json().get("access_token")
    logger.info("✅ Obtained Zoom API token.")
    return token


def list_zoom_rooms(token):
    logger.debug("📡 Listing available Zoom Rooms...")
    url = "https://api.zoom.us/v2/rooms?status=available"
    headers = {"Authorization": f"Bearer {token}"}
    res = requests.get(url, headers=headers)
    res.raise_for_status()
    rooms = res.json().get("rooms", [])
    logger.info(f"🏢 Found {len(rooms)} available Zoom Rooms.")
    return rooms


def join_zoom_room(token, room):
    logger.debug(f"🔗 Attempting to join room: {room['name']} ({room['id']})")
    url = f"https://api.zoom.us/v2/rooms/{room['id']}/events"
    payload = {
        "method": "zoomroom.meeting_join",
        "params": {
            "meeting_number": MEETING_NUMBER,
            "passcode": MEETING_PASSCODE
        }
    }
    res = requests.patch(url, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }, json=payload)
    if res.status_code == 202:
        logger.info(f"✅ Room '{room['name']}' successfully joined the meeting.")
        remove_room_from_retry_list(room['id'])
    else:
        logger.warning(f"❌ Failed to join room '{room['name']}': HTTP {res.status_code}")
        if room not in retry_rooms:
            retry_rooms.append(room)


def leave_zoom_room(token, room):
    logger.debug(f"🚪 Attempting to leave room: {room['name']} ({room['id']})")
    url = f"https://api.zoom.us/v2/rooms/{room['id']}/events"
    payload = {"method": "zoomroom.meeting_leave", "params": {}}
    res = requests.patch(url, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }, json=payload)
    if res.status_code == 202:
        logger.info(f"👋 Room '{room['name']}' left the meeting.")
    else:
        logger.warning(f"⚠️ Failed to leave room '{room['name']}': HTTP {res.status_code}")


def schedule_room_leave(token, room, delay=30):
    logger.debug(f"🕒 Scheduling leave for room '{room['name']}' in {delay} seconds.")
    def leave_later():
        time.sleep(delay)
        leave_zoom_room(token, room)
    threading.Thread(target=leave_later, daemon=True).start()


def save_video_frame(video_data, user_id, timestamp, user_name):
    buffer = video_data if isinstance(video_data, bytes) else base64.b64decode(video_data)
    file_ext = 'jpg'
    safe_user = f"{user_name}_{user_id}".replace('/', '_').replace('\\', '_')
    user_key = safe_user

    if user_key not in user_frame_counters:
        logger.debug(f"🆕 Initializing frame counter for {user_key}")
        user_frame_counters[user_key] = 0
    user_frame_counters[user_key] += 1

    if user_frame_counters[user_key] <= 3:
        logger.info(f"⏭️ Skipping early frame #{user_frame_counters[user_key]} for {user_key}")
        return

    folder = Path("recordings") / user_key
    folder.mkdir(parents=True, exist_ok=True)
    files = sorted(folder.glob(f"*.{file_ext}"), key=os.path.getmtime)

    if len(files) >= MAX_FILES_PER_USER:
        oldest = files[0]
        oldest.unlink()
        logger.info(f"🗑️ Deleted oldest frame for {user_key}: {oldest.name}")

    filename = f"{timestamp}.{file_ext}"
    path = folder / filename
    with open(path, 'wb') as f:
        f.write(buffer)
    logger.info(f"💾 Saved frame for {user_key} to {path}")


def run_zoom_room_joiner():
    logger.info("🚀 Starting Zoom Room join orchestration...")
    load_retry_list()
    token = get_zoom_api_token()
    available_rooms = list_zoom_rooms(token)
    room_map = {r['id']: r for r in available_rooms + retry_rooms}
    unique_rooms = list(room_map.values())
    logger.info(f"🔁 Attempting to join {len(unique_rooms)} total rooms (including retries).")

    for room in unique_rooms:
        join_zoom_room(token, room)
        schedule_room_leave(token, room)

    save_retry_list()
    logger.info("✅ Zoom Room join orchestration complete.")


if __name__ == '__main__':
    # 💡 Safe place to start room joining
    run_zoom_room_joiner()
    start_zoom_event_websocket()
    app.run(host='0.0.0.0', port=PORT)
