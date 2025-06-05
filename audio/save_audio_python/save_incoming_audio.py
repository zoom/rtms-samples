import os
import json
import hmac
import hashlib
import asyncio
import websockets
import uvicorn
import base64
import ssl
from fastapi import FastAPI, Request
from dotenv import load_dotenv
import subprocess
from pathlib import Path

# Load environment variables from .env file
load_dotenv()

app = FastAPI()
port = int(os.getenv("PORT", 3000))

ZOOM_SECRET_TOKEN = os.getenv("ZOOM_SECRET_TOKEN")
CLIENT_ID = os.getenv("ZM_CLIENT_ID")
CLIENT_SECRET = os.getenv("ZM_CLIENT_SECRET")
WEBHOOK_PATH = os.getenv("WEBHOOK_PATH", "/webhook")

# Dictionary to keep track of active WebSocket connections and audio chunks
active_connections = {}
audio_chunks = {}

def generate_signature(client_id, meeting_uuid, stream_id, client_secret):
    """Generate signature for authentication."""
    print('Generating signature with parameters:')
    print('meetingUuid:', meeting_uuid)
    print('streamId:', stream_id)

    # Create a message string and generate an HMAC SHA256 signature
    message = f"{client_id},{meeting_uuid},{stream_id}"
    return hmac.new(
        client_secret.encode(),
        message.encode(),
        hashlib.sha256
    ).hexdigest()

async def convert_raw_to_wav(input_file, output_file):
    """Convert raw audio data to WAV format using ffmpeg."""
    try:
        command = [
            'ffmpeg', '-y',
            '-f', 's16le',
            '-ar', '16000',
            '-ac', '1',
            '-i', input_file,
            output_file
        ]
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        await process.communicate()
        
        # Clean up raw file
        os.unlink(input_file)
        print(f"WAV saved: {output_file}")
    except Exception as e:
        print(f"Conversion error: {e}")

async def connect_to_signaling_websocket(meeting_uuid, stream_id, server_url):
    """Connect to the signaling WebSocket server."""
    print(f"Connecting to signaling WebSocket for meeting {meeting_uuid}")

    try:
        async with websockets.connect(server_url) as ws:
            # Store connection for cleanup later
            if meeting_uuid not in active_connections:
                active_connections[meeting_uuid] = {}
            active_connections[meeting_uuid]["signaling"] = ws

            print(f"Signaling WebSocket connection opened for meeting {meeting_uuid}")
            signature = generate_signature(CLIENT_ID, meeting_uuid, stream_id, CLIENT_SECRET)

            # Send handshake message
            handshake = {
                "msg_type": 1,  # SIGNALING_HAND_SHAKE_REQ
                "protocol_version": 1,
                "meeting_uuid": meeting_uuid,
                "rtms_stream_id": stream_id,
                "sequence": int(asyncio.get_event_loop().time() * 1e9),
                "signature": signature
            }
            await ws.send(json.dumps(handshake))
            print("Sent handshake to signaling server")

            while True:
                try:
                    data = await ws.recv()
                    msg = json.loads(data)
                    print("Signaling Message:", json.dumps(msg, indent=2))

                    # Handle successful handshake response
                    if msg["msg_type"] == 2 and msg["status_code"] == 0:  # SIGNALING_HAND_SHAKE_RESP
                        media_url = msg.get("media_server", {}).get("server_urls", {}).get("all")
                        if media_url:
                            # Connect to the media WebSocket server
                            asyncio.create_task(
                                connect_to_media_websocket(media_url, meeting_uuid, stream_id, ws)
                            )

                    # Respond to keep-alive requests
                    if msg["msg_type"] == 12:  # KEEP_ALIVE_REQ
                        keep_alive_response = {
                            "msg_type": 13,  # KEEP_ALIVE_RESP
                            "timestamp": msg["timestamp"]
                        }
                        print("Responding to Signaling KEEP_ALIVE_REQ:", keep_alive_response)
                        await ws.send(json.dumps(keep_alive_response))

                except websockets.exceptions.ConnectionClosed:
                    break
                except Exception as e:
                    print(f"Error processing message: {e}")
                    break

    except Exception as e:
        print(f"Signaling socket error: {e}")
    finally:
        print("Signaling socket closed")
        if meeting_uuid in active_connections:
            active_connections[meeting_uuid].pop("signaling", None)

async def connect_to_media_websocket(media_url, meeting_uuid, stream_id, signaling_socket):
    """Connect to the media WebSocket server."""
    print(f"Connecting to media WebSocket at {media_url}")

    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE

    try:
        async with websockets.connect(media_url, ssl=ssl_context) as media_ws:
            # Store connection for cleanup later
            if meeting_uuid in active_connections:
                active_connections[meeting_uuid]["media"] = media_ws

            # Initialize audio chunks list for this meeting
            audio_chunks[meeting_uuid] = []

            signature = generate_signature(CLIENT_ID, meeting_uuid, stream_id, CLIENT_SECRET)
            handshake = {
                "msg_type": 3,  # DATA_HAND_SHAKE_REQ
                "protocol_version": 1,
                "meeting_uuid": meeting_uuid,
                "rtms_stream_id": stream_id,
                "signature": signature,
                "media_type": 1,  # MEDIA_DATA_AUDIO
                "payload_encryption": False
            }
            await media_ws.send(json.dumps(handshake))

            while True:
                try:
                    data = await media_ws.recv()
                    try:
                        # Try to parse as JSON first
                        msg = json.loads(data)
                        print("Media JSON Message:", json.dumps(msg, indent=2))

                        # Handle successful media handshake
                        if msg["msg_type"] == 4 and msg["status_code"] == 0:  # DATA_HAND_SHAKE_RESP
                            await signaling_socket.send(json.dumps({
                                "msg_type": 7,  # CLIENT_READY_ACK
                                "rtms_stream_id": stream_id
                            }))
                            print("Media handshake successful, sent start streaming request")

                        # Respond to keep-alive requests
                        if msg["msg_type"] == 12:  # KEEP_ALIVE_REQ
                            await media_ws.send(json.dumps({
                                "msg_type": 13,  # KEEP_ALIVE_RESP
                                "timestamp": msg["timestamp"]
                            }))
                            print("Responded to Media KEEP_ALIVE_REQ")

                        # Handle audio data
                        if msg["msg_type"] == 14 and msg.get("content", {}).get("data"):
                            # Decode base64 audio data
                            audio_data = base64.b64decode(msg["content"]["data"])
                            if meeting_uuid in audio_chunks:
                                audio_chunks[meeting_uuid].append(audio_data)
                                print(f"Received audio chunk, total chunks: {len(audio_chunks[meeting_uuid])}")

                    except json.JSONDecodeError:
                        print("Received binary data (not JSON)")

                except websockets.exceptions.ConnectionClosed:
                    break
                except Exception as e:
                    print(f"Error processing message: {e}")
                    break

    except Exception as e:
        print(f"Media socket error: {e}")
    finally:
        print("Media socket closed")
        if meeting_uuid in active_connections:
            active_connections[meeting_uuid].pop("media", None)

@app.post(WEBHOOK_PATH)
async def webhook(request: Request):
    """Handle webhook requests."""
    body = await request.json()
    print("RTMS Webhook received:", json.dumps(body, indent=2))
    event = body.get("event")
    payload = body.get("payload", {})

    # Handle URL validation event
    if event == "endpoint.url_validation" and payload.get("plainToken"):
        hash_obj = hmac.new(
            ZOOM_SECRET_TOKEN.encode(),
            payload["plainToken"].encode(),
            hashlib.sha256
        )
        print("Responding to URL validation challenge")
        return {
            "plainToken": payload["plainToken"],
            "encryptedToken": hash_obj.hexdigest()
        }

    # Handle RTMS started event
    if event == "meeting.rtms_started":
        print("RTMS Started event received")
        meeting_uuid = payload.get("meeting_uuid")
        rtms_stream_id = payload.get("rtms_stream_id")
        server_urls = payload.get("server_urls")
        if all([meeting_uuid, rtms_stream_id, server_urls]):
            asyncio.create_task(
                connect_to_signaling_websocket(meeting_uuid, rtms_stream_id, server_urls)
            )

    # Handle RTMS stopped event
    if event == "meeting.rtms_stopped":
        print("RTMS Stopped event received")
        meeting_uuid = payload.get("meeting_uuid")
        
        # Save audio data to WAV file
        if meeting_uuid in audio_chunks and audio_chunks[meeting_uuid]:
            meeting_id = ''.join(c if c.isalnum() else '_' for c in meeting_uuid)
            raw_filename = f"recording_{meeting_id}.raw"
            wav_filename = f"recording_{meeting_id}.wav"

            # Combine all audio chunks
            combined_data = b''.join(audio_chunks[meeting_uuid])
            
            # Write raw audio data to file
            with open(raw_filename, 'wb') as f:
                f.write(combined_data)

            # Convert to WAV
            await convert_raw_to_wav(raw_filename, wav_filename)
            
            # Clean up audio chunks
            audio_chunks.pop(meeting_uuid, None)

        # Close all active WebSocket connections
        if meeting_uuid in active_connections:
            connections = active_connections[meeting_uuid]
            for conn in connections.values():
                if conn and hasattr(conn, "close"):
                    await conn.close()
            active_connections.pop(meeting_uuid, None)

    return {"status": "ok"}

if __name__ == "__main__":
    print(f"Server running at http://localhost:{port}")
    print(f"Webhook endpoint available at http://localhost:{port}{WEBHOOK_PATH}")
    uvicorn.run(app, host="0.0.0.0", port=port) 