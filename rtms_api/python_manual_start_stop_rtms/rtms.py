import os
import json
import asyncio
import websockets
import requests
import hmac
import hashlib
from flask import Flask, request, jsonify
from dotenv import load_dotenv

# Load environment variables from .env
load_dotenv()

app = Flask(__name__)

# Step 1: Webhook Receiver - Listen for meeting events
@app.route("/webhook", methods=['POST'])
def webhook():
    data = request.get_json()
    event = data.get('event')
    payload = data.get('payload')
    
    print(f'Webhook received: {event}')
    print(f'Payload: {json.dumps(payload, indent=2)}')

    # Step 2a: Listen to meeting started event
    if event == 'meeting.started':
        print('Meeting started, initiating RTMS...')
        meeting_object = payload.get('object', {})
        meeting_id = meeting_object.get('id')
        meeting_uuid = meeting_object.get('uuid')
        
        try:
            # Step 2b: Get access token
            access_token = generate_access_token()
            
            # Step 2c: Make API call to start RTMS
            start_rtms(meeting_id, access_token)
            
            print(f'RTMS started for meeting {meeting_id}')
            
            # Schedule automatic RTMS stop after 60 seconds
            schedule_rtms_stop(meeting_id, access_token)
        except Exception as error:
            print(f'Error starting RTMS: {error}')

    # Step 3: RTMS started event
    if event == 'meeting.rtms_started':
        print('Starting RTMS connection...')
        meeting_uuid = payload.get('meeting_uuid')
        rtms_stream_id = payload.get('rtms_stream_id')
        server_urls = payload.get('server_urls')
        asyncio.run(connect_to_signaling_websocket(meeting_uuid, rtms_stream_id, server_urls))

    # When meeting RTMS stops, log the stop event
    if event == 'meeting.rtms_stopped':
        meeting_uuid = payload.get('meeting_uuid')
        print(f'Meeting {meeting_uuid} stopped')
        # Open WebSocket connections will close naturally

    return jsonify({'status': 'success'}), 200

# Step 4: Generate Signature for authentication handshake
def generate_signature(meeting_uuid, stream_id):
    client_id = os.getenv('ZOOM_CLIENT_ID')
    client_secret = os.getenv('ZOOM_CLIENT_SECRET')
    
    if not client_id or not client_secret:
        raise Exception('ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET must be set in environment variables')
    
    message = f"{client_id},{meeting_uuid},{stream_id}"
    signature = hmac.new(
        client_secret.encode('utf-8'),
        message.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    return signature

# Helper function: Generate access token from environment variable
def generate_access_token():
    access_token = os.getenv('access_token')
    if not access_token:
        raise Exception('access_token not found in environment variables')
    print('Using access token from environment variables')
    return access_token

# Helper function: Manually start RTMS using Zoom API
def start_rtms(meeting_id, access_token):
    try:
        url = f"https://api.zoom.us/v2/live_meetings/{meeting_id}/rtms_app/status"
        headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {access_token}'
        }
        data = {
            'action': 'start',
            'settings': {
                'client_id': os.getenv('ZOOM_CLIENT_ID')
            }
        }
        
        response = requests.patch(url, json=data, headers=headers)
        
        # Better error handling
        if response.status_code != 200:
            print(f'API Error: Status {response.status_code}')
            print(f'Response: {response.text}')
            raise Exception(f'API call failed with status {response.status_code}')
        
        try:
            result = response.json()
            print(f'RTMS start response: {result}')
            return result
        except json.JSONDecodeError:
            print(f'Invalid JSON response: {response.text}')
            raise Exception('Invalid JSON response from API')
            
    except requests.exceptions.RequestException as error:
        print(f'Error starting RTMS via API: {error}')
        raise error

# Step 5: WebSocket 1 - Connect to Signaling WebSocket
async def connect_to_signaling_websocket(meeting_uuid, stream_id, server_urls):
    print(f'Connecting to signaling WebSocket: {server_urls}')
    
    try:
        # Disable SSL certificate verification for development
        import ssl
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        async with websockets.connect(server_urls, ssl=ssl_context) as signaling_ws:
            print('Signaling WebSocket opened')
            
            # Send handshake
            handshake_message = {
                'msg_type': 1,  # HANDSHAKE_REQUEST
                'meeting_uuid': meeting_uuid,
                'rtms_stream_id': stream_id,
                'signature': generate_signature(meeting_uuid, stream_id)
            }
            await signaling_ws.send(json.dumps(handshake_message))
            
            # Handle incoming signaling messages
            async for message in signaling_ws:
                msg = json.loads(message)
                print(f'Signaling message: {msg}')

                # If handshake is successful, proceed to media connection
                if msg.get('msg_type') == 2 and msg.get('status_code') == 0:
                    media_url = msg['media_server']['server_urls']['transcript']
                    await connect_to_media_websocket(media_url, meeting_uuid, stream_id, signaling_ws)

                # If keep-alive request is received, respond with ACK
                if msg.get('msg_type') == 12:
                    ack_message = {
                        'msg_type': 13,
                        'timestamp': msg.get('timestamp')
                    }
                    await signaling_ws.send(json.dumps(ack_message))
                    
    except Exception as error:
        print(f'Signaling WebSocket error: {error}')
    finally:
        print('Signaling WebSocket closed')

# Step 6: WebSocket 2 - Connect to Media WebSocket
async def connect_to_media_websocket(media_url, meeting_uuid, stream_id, signaling_socket):
    print(f'Connecting to media WebSocket: {media_url}')
    
    try:
        # Disable SSL certificate verification for development
        import ssl
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        async with websockets.connect(media_url, ssl=ssl_context) as media_ws:
            print('Media WebSocket opened')
            
            # Send media handshake
            media_handshake = {
                'msg_type': 3,  # MEDIA_HANDSHAKE_REQUEST
                'protocol_version': 1,
                'sequence': 0,
                'meeting_uuid': meeting_uuid,
                'rtms_stream_id': stream_id,
                'signature': generate_signature(meeting_uuid, stream_id),
                'media_type': 8  # Request transcript stream
            }
            await media_ws.send(json.dumps(media_handshake))
            
            # Handle incoming media messages
            async for message in media_ws:
                msg = json.loads(message)
                print(f'Media message received: {msg}')

                # Respond to keep-alive request from media server
                if msg.get('msg_type') == 12:
                    print('Responding to media keep-alive')
                    ack_message = {
                        'msg_type': 13,
                        'timestamp': msg.get('timestamp')
                    }
                    await media_ws.send(json.dumps(ack_message))

                # If media handshake is successful, notify signaling server that client is ready
                if msg.get('msg_type') == 4 and msg.get('status_code') == 0:
                    print('Media handshake successful, sending CLIENT_READY_ACK')
                    ready_message = {
                        'msg_type': 7,
                        'rtms_stream_id': stream_id
                    }
                    await signaling_socket.send(json.dumps(ready_message))

                # Log incoming transcript data
                if msg.get('msg_type') == 5:
                    print(f'Transcript: {msg}')
                    
    except Exception as error:
        print(f'Media WebSocket error: {error}')
    finally:
        print('Media WebSocket closed')

# Step 7: Stop RTMS using Zoom API
def stop_rtms(meeting_id, access_token):
    try:
        url = f"https://api.zoom.us/v2/live_meetings/{meeting_id}/rtms_app/status"
        headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {access_token}'
        }
        data = {
            'action': 'stop',
            'settings': {
                'client_id': os.getenv('ZOOM_CLIENT_ID')
            }
        }
        
        response = requests.patch(url, json=data, headers=headers)
        response.raise_for_status()
        
        print(f'RTMS stop response: {response.json()}')
        return response.json()
    except requests.exceptions.RequestException as error:
        print(f'Error stopping RTMS via API: {error}')
        raise error

# Helper function: Schedule RTMS stop after 10 seconds
def schedule_rtms_stop(meeting_id, access_token):
    print(f'Scheduling RTMS stop for meeting {meeting_id} in 10 seconds...')
    
    def stop_after_delay():
        import threading
        import time
        
        def delayed_stop():
            time.sleep(10)  # 10 seconds delay
            try:
                print(f'Stopping RTMS for meeting {meeting_id}...')
                stop_rtms(meeting_id, access_token)
                print(f'RTMS stopped successfully for meeting {meeting_id}')
            except Exception as error:
                print(f'Failed to stop RTMS for meeting {meeting_id}: {error}')
        
        thread = threading.Thread(target=delayed_stop)
        thread.daemon = True
        thread.start()
    
    stop_after_delay()

# Step 8: Start Flask server on port 3000
if __name__ == '__main__':
    print('Server running on port 3000')
    app.run(host='0.0.0.0', port=3000, debug=True)
