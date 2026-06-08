# RTMS Connection Flow

> **For Advanced Users**: This guide explains how RTMS connections work at the protocol level. Use this to implement your own client, customize connection handling, or understand what the SDK/library does under the hood.
>
> **Requirements**: Any modern language with native support for webhooks (HTTP POST), WebSocket connections, and HMAC-SHA256 signing (e.g., Node.js, Python, Go, Java, C#, Rust).

## Overview

RTMS uses a two-phase WebSocket connection:

1. **Signaling WebSocket** - Authenticates and returns media server URL
2. **Media WebSocket** - Receives actual audio/video/transcript data

This is the **exact same flow** that the SDK and RTMSManager library use internally. The library simply adds convenience features on top:

- Automatic reconnection with exponential backoff
- Event emitter pattern for cleaner code
- Helper utilities for audio/video processing
- Connection state management
- Keep-alive handling

If you need full control or are working in a language without SDK support, you can implement this flow directly using any WebSocket client.

## Connection Flow

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Zoom Webhook   │────▶│   Your Server    │────▶│ Signaling WSS   │
│  rtms_started   │     │                  │     │ (Handshake)     │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                                                 ┌────────▼────────┐
                                                 │  Media WSS      │
                                                 │  (Data Stream)  │
                                                 └────────┬────────┘
                                                          │
                                                 ┌────────▼────────┐
                                                 │  Your Handler   │
                                                 │  (Process Data) │
                                                 └─────────────────┘
```

## Step-by-Step Flow

### 1. Receive Webhook

Zoom sends `meeting.rtms_started` webhook containing:
- `meeting_uuid` - Unique meeting identifier
- `rtms_stream_id` - Stream identifier
- `server_urls` - Signaling server WebSocket URL

**Webhook Payload Example:**

```json
{
  "event": "meeting.rtms_started",
  "payload": {
    "object": {
      "meeting_uuid": "abc123...",
      "rtms_stream_id": "stream_xyz...",
      "server_urls": "wss://rtms-sjc.zoom.us/ws"
    }
  }
}
```

**JavaScript (Express):**

```javascript
const express = require('express');
const crypto = require('crypto');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

app.post('/webhook', (req, res) => {
  const { event, payload } = req.body;
  
  if (event === 'meeting.rtms_started') {
    const { meeting_uuid, rtms_stream_id, server_urls } = payload.object;
    
    // Connect to signaling WebSocket
    connectToSignaling(meeting_uuid, rtms_stream_id, server_urls);
  }
  
  res.status(200).send('OK');
});

app.listen(3000);
```

**Python (Flask):**

```python
from flask import Flask, request
import hashlib
import hmac
import websocket
import json
import threading

app = Flask(__name__)

@app.route('/webhook', methods=['POST'])
def webhook():
    data = request.json
    event = data.get('event')
    
    if event == 'meeting.rtms_started':
        payload = data['payload']['object']
        meeting_uuid = payload['meeting_uuid']
        rtms_stream_id = payload['rtms_stream_id']
        server_urls = payload['server_urls']
        
        # Connect in background thread
        thread = threading.Thread(
            target=connect_to_signaling,
            args=(meeting_uuid, rtms_stream_id, server_urls)
        )
        thread.start()
    
    return 'OK', 200

if __name__ == '__main__':
    app.run(port=3000)
```

**Go (net/http):**

```go
package main

import (
    "encoding/json"
    "net/http"
)

type WebhookPayload struct {
    Event   string `json:"event"`
    Payload struct {
        Object struct {
            MeetingUUID  string `json:"meeting_uuid"`
            RTMSStreamID string `json:"rtms_stream_id"`
            ServerURLs   string `json:"server_urls"`
        } `json:"object"`
    } `json:"payload"`
}

func webhookHandler(w http.ResponseWriter, r *http.Request) {
    var payload WebhookPayload
    json.NewDecoder(r.Body).Decode(&payload)
    
    if payload.Event == "meeting.rtms_started" {
        obj := payload.Payload.Object
        go connectToSignaling(obj.MeetingUUID, obj.RTMSStreamID, obj.ServerURLs)
    }
    
    w.WriteHeader(http.StatusOK)
}

func main() {
    http.HandleFunc("/webhook", webhookHandler)
    http.ListenAndServe(":3000", nil)
}
```

---

### 2. Generate HMAC Signature

All handshakes require HMAC-SHA256 signature:
- **Message**: `{client_id},{meeting_uuid},{stream_id}`
- **Key**: `client_secret`
- **Output**: Hex-encoded hash

**JavaScript:**

```javascript
function generateSignature(clientId, meetingUuid, streamId, clientSecret) {
  const message = `${clientId},${meetingUuid},${streamId}`;
  return crypto.createHmac('sha256', clientSecret)
    .update(message)
    .digest('hex');
}

// Usage
const signature = generateSignature(
  process.env.ZOOM_CLIENT_ID,
  meeting_uuid,
  rtms_stream_id,
  process.env.ZOOM_CLIENT_SECRET
);
```

**Python:**

```python
import hmac
import hashlib

def generate_signature(client_id, meeting_uuid, stream_id, client_secret):
    message = f"{client_id},{meeting_uuid},{stream_id}"
    return hmac.new(
        client_secret.encode(),
        message.encode(),
        hashlib.sha256
    ).hexdigest()

# Usage
import os
signature = generate_signature(
    os.environ['ZOOM_CLIENT_ID'],
    meeting_uuid,
    rtms_stream_id,
    os.environ['ZOOM_CLIENT_SECRET']
)
```

**Go:**

```go
import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "os"
)

func generateSignature(clientID, meetingUUID, streamID, clientSecret string) string {
    message := clientID + "," + meetingUUID + "," + streamID
    h := hmac.New(sha256.New, []byte(clientSecret))
    h.Write([]byte(message))
    return hex.EncodeToString(h.Sum(nil))
}

// Usage
signature := generateSignature(
    os.Getenv("ZOOM_CLIENT_ID"),
    meetingUUID,
    rtmsStreamID,
    os.Getenv("ZOOM_CLIENT_SECRET"),
)
```

---

### 3. Connect to Signaling WebSocket

Connect to the `server_urls` and send handshake:

```json
{
  "msg_type": 1,
  "protocol_version": 1,
  "meeting_uuid": "<meeting_uuid>",
  "rtms_stream_id": "<stream_id>",
  "sequence": <random_number>,
  "signature": "<hmac_sha256_signature>",
  "buffer_data": false
}
```

**JavaScript:**

```javascript
function connectToSignaling(meetingUuid, streamId, serverUrl) {
  const signalingWs = new WebSocket(serverUrl);
  
  signalingWs.on('open', () => {
    const signature = generateSignature(
      process.env.ZOOM_CLIENT_ID,
      meetingUuid,
      streamId,
      process.env.ZOOM_CLIENT_SECRET
    );
    
    const handshake = {
      msg_type: 1,
      protocol_version: 1,
      meeting_uuid: meetingUuid,
      rtms_stream_id: streamId,
      sequence: Math.floor(Math.random() * 1000000),
      signature: signature,
      buffer_data: false
    };
    
    signalingWs.send(JSON.stringify(handshake));
  });
  
  signalingWs.on('message', (data) => {
    const msg = JSON.parse(data);
    handleSignalingMessage(msg, signalingWs, meetingUuid, streamId);
  });
}
```

**Python:**

```python
import websocket
import json
import random

def connect_to_signaling(meeting_uuid, stream_id, server_url):
    ws = websocket.WebSocketApp(
        server_url,
        on_open=lambda ws: on_signaling_open(ws, meeting_uuid, stream_id),
        on_message=lambda ws, msg: on_signaling_message(ws, msg, meeting_uuid, stream_id)
    )
    ws.run_forever()

def on_signaling_open(ws, meeting_uuid, stream_id):
    signature = generate_signature(
        os.environ['ZOOM_CLIENT_ID'],
        meeting_uuid,
        stream_id,
        os.environ['ZOOM_CLIENT_SECRET']
    )
    
    handshake = {
        "msg_type": 1,
        "protocol_version": 1,
        "meeting_uuid": meeting_uuid,
        "rtms_stream_id": stream_id,
        "sequence": random.randint(1, 1000000),
        "signature": signature,
        "buffer_data": False
    }
    
    ws.send(json.dumps(handshake))
```

**Go:**

```go
import (
    "encoding/json"
    "math/rand"
    "github.com/gorilla/websocket"
)

func connectToSignaling(meetingUUID, streamID, serverURL string) {
    conn, _, err := websocket.DefaultDialer.Dial(serverURL, nil)
    if err != nil {
        return
    }
    
    signature := generateSignature(
        os.Getenv("ZOOM_CLIENT_ID"),
        meetingUUID,
        streamID,
        os.Getenv("ZOOM_CLIENT_SECRET"),
    )
    
    handshake := map[string]interface{}{
        "msg_type":         1,
        "protocol_version": 1,
        "meeting_uuid":     meetingUUID,
        "rtms_stream_id":   streamID,
        "sequence":         rand.Intn(1000000),
        "signature":        signature,
        "buffer_data":      false,
    }
    
    conn.WriteJSON(handshake)
    
    // Read messages
    for {
        _, message, err := conn.ReadMessage()
        if err != nil {
            break
        }
        handleSignalingMessage(conn, message, meetingUUID, streamID)
    }
}
```

---

### 4. Receive Media Server URL

On successful handshake (`msg_type: 2`, `status_code: 0`), extract the media server URL:

```json
{
  "msg_type": 2,
  "status_code": 0,
  "media_server": {
    "server_urls": {
      "all": "wss://rtms-media-sjc.zoom.us/media"
    }
  }
}
```

**JavaScript:**

```javascript
function handleSignalingMessage(msg, signalingWs, meetingUuid, streamId) {
  switch (msg.msg_type) {
    case 2: // SIGNALING_HANDSHAKE_RESP
      if (msg.status_code === 0) {
        const mediaUrl = msg.media_server.server_urls.all;
        connectToMedia(mediaUrl, signalingWs, meetingUuid, streamId);
      } else {
        console.error('Signaling handshake failed:', msg.status_code);
      }
      break;
      
    case 12: // KEEP_ALIVE_REQ
      signalingWs.send(JSON.stringify({
        msg_type: 13,
        timestamp: msg.timestamp
      }));
      break;
  }
}
```

**Python:**

```python
def on_signaling_message(ws, message, meeting_uuid, stream_id):
    msg = json.loads(message)
    
    if msg['msg_type'] == 2:  # SIGNALING_HANDSHAKE_RESP
        if msg['status_code'] == 0:
            media_url = msg['media_server']['server_urls']['all']
            connect_to_media(media_url, ws, meeting_uuid, stream_id)
        else:
            print(f"Signaling handshake failed: {msg['status_code']}")
    
    elif msg['msg_type'] == 12:  # KEEP_ALIVE_REQ
        ws.send(json.dumps({
            "msg_type": 13,
            "timestamp": msg['timestamp']
        }))
```

**Go:**

```go
type SignalingResponse struct {
    MsgType     int `json:"msg_type"`
    StatusCode  int `json:"status_code"`
    MediaServer struct {
        ServerURLs struct {
            All string `json:"all"`
        } `json:"server_urls"`
    } `json:"media_server"`
    Timestamp int64 `json:"timestamp"`
}

func handleSignalingMessage(conn *websocket.Conn, data []byte, meetingUUID, streamID string) {
    var msg SignalingResponse
    json.Unmarshal(data, &msg)
    
    switch msg.MsgType {
    case 2: // SIGNALING_HANDSHAKE_RESP
        if msg.StatusCode == 0 {
            mediaURL := msg.MediaServer.ServerURLs.All
            go connectToMedia(mediaURL, conn, meetingUUID, streamID)
        }
    
    case 12: // KEEP_ALIVE_REQ
        conn.WriteJSON(map[string]interface{}{
            "msg_type":  13,
            "timestamp": msg.Timestamp,
        })
    }
}
```

---

### 5. Connect to Media WebSocket

Connect to media server and send handshake with media configuration:

```json
{
  "msg_type": 3,
  "protocol_version": 1,
  "meeting_uuid": "<meeting_uuid>",
  "rtms_stream_id": "<stream_id>",
  "signature": "<hmac_sha256_signature>",
  "media_type": 32,
  "payload_encryption": false,
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
    }
  }
}
```

**JavaScript:**

```javascript
let mediaWs = null;

function connectToMedia(mediaUrl, signalingWs, meetingUuid, streamId) {
  mediaWs = new WebSocket(mediaUrl);
  
  mediaWs.on('open', () => {
    const signature = generateSignature(
      process.env.ZOOM_CLIENT_ID,
      meetingUuid,
      streamId,
      process.env.ZOOM_CLIENT_SECRET
    );
    
    const handshake = {
      msg_type: 3,
      protocol_version: 1,
      meeting_uuid: meetingUuid,
      rtms_stream_id: streamId,
      signature: signature,
      media_type: 32, // All media types
      payload_encryption: false,
      media_params: {
        audio: {
          content_type: 2, // RAW_AUDIO
          sample_rate: 1,  // SR_16K
          channel: 1,      // MONO
          codec: 1,        // L16
          data_opt: 1,     // AUDIO_MIXED_STREAM
          send_rate: 100   // 100ms chunks
        },
        video: {
          content_type: 3, // RAW_VIDEO
          codec: 7,        // H264
          resolution: 2,   // 720p
          fps: 25
        }
      }
    };
    
    mediaWs.send(JSON.stringify(handshake));
  });
  
  mediaWs.on('message', (data) => {
    const msg = JSON.parse(data);
    handleMediaMessage(msg, mediaWs, signalingWs, streamId);
  });
}
```

**Python:**

```python
media_ws = None

def connect_to_media(media_url, signaling_ws, meeting_uuid, stream_id):
    global media_ws
    
    def on_open(ws):
        signature = generate_signature(
            os.environ['ZOOM_CLIENT_ID'],
            meeting_uuid,
            stream_id,
            os.environ['ZOOM_CLIENT_SECRET']
        )
        
        handshake = {
            "msg_type": 3,
            "protocol_version": 1,
            "meeting_uuid": meeting_uuid,
            "rtms_stream_id": stream_id,
            "signature": signature,
            "media_type": 32,  # All media types
            "payload_encryption": False,
            "media_params": {
                "audio": {
                    "content_type": 2,  # RAW_AUDIO
                    "sample_rate": 1,   # SR_16K
                    "channel": 1,       # MONO
                    "codec": 1,         # L16
                    "data_opt": 1,      # AUDIO_MIXED_STREAM
                    "send_rate": 100    # 100ms chunks
                },
                "video": {
                    "content_type": 3,  # RAW_VIDEO
                    "codec": 7,         # H264
                    "resolution": 2,    # 720p
                    "fps": 25
                }
            }
        }
        ws.send(json.dumps(handshake))
    
    def on_message(ws, message):
        msg = json.loads(message)
        handle_media_message(msg, ws, signaling_ws, stream_id)
    
    media_ws = websocket.WebSocketApp(
        media_url,
        on_open=on_open,
        on_message=on_message
    )
    
    thread = threading.Thread(target=media_ws.run_forever)
    thread.start()
```

**Go:**

```go
func connectToMedia(mediaURL string, signalingConn *websocket.Conn, meetingUUID, streamID string) {
    mediaConn, _, err := websocket.DefaultDialer.Dial(mediaURL, nil)
    if err != nil {
        return
    }
    
    signature := generateSignature(
        os.Getenv("ZOOM_CLIENT_ID"),
        meetingUUID,
        streamID,
        os.Getenv("ZOOM_CLIENT_SECRET"),
    )
    
    handshake := map[string]interface{}{
        "msg_type":           3,
        "protocol_version":   1,
        "meeting_uuid":       meetingUUID,
        "rtms_stream_id":     streamID,
        "signature":          signature,
        "media_type":         32, // All media types
        "payload_encryption": false,
        "media_params": map[string]interface{}{
            "audio": map[string]interface{}{
                "content_type": 2,   // RAW_AUDIO
                "sample_rate":  1,   // SR_16K
                "channel":      1,   // MONO
                "codec":        1,   // L16
                "data_opt":     1,   // AUDIO_MIXED_STREAM
                "send_rate":    100, // 100ms chunks
            },
            "video": map[string]interface{}{
                "content_type": 3,  // RAW_VIDEO
                "codec":      7,  // H264
                "resolution": 2,  // 720p
                "fps":        25,
            },
        },
    }
    
    mediaConn.WriteJSON(handshake)
    
    for {
        _, message, err := mediaConn.ReadMessage()
        if err != nil {
            break
        }
        handleMediaMessage(mediaConn, signalingConn, message, streamID)
    }
}
```

---

### 6. Start Streaming

After media handshake succeeds (`msg_type: 4`, `status_code: 0`), send start command to **signaling** socket:

```json
{
  "msg_type": 7,
  "rtms_stream_id": "<stream_id>"
}
```

**JavaScript:**

```javascript
function handleMediaMessage(msg, mediaWs, signalingWs, streamId) {
  switch (msg.msg_type) {
    case 4: // MEDIA_HANDSHAKE_RESP
      if (msg.status_code === 0) {
        // Send start command to SIGNALING socket
        signalingWs.send(JSON.stringify({
          msg_type: 7,
          rtms_stream_id: streamId
        }));
        console.log('Media streaming started');
      }
      break;
    
    case 12: // KEEP_ALIVE_REQ
      mediaWs.send(JSON.stringify({
        msg_type: 13,
        timestamp: msg.timestamp
      }));
      break;
    
    case 14: // MEDIA_DATA_AUDIO
      handleAudioData(msg);
      break;
    
    case 15: // MEDIA_DATA_VIDEO
      handleVideoData(msg);
      break;
    
    case 17: // MEDIA_DATA_TRANSCRIPT
      handleTranscript(msg);
      break;
  }
}
```

**Python:**

```python
def handle_media_message(msg, media_ws, signaling_ws, stream_id):
    msg_type = msg['msg_type']
    
    if msg_type == 4:  # MEDIA_HANDSHAKE_RESP
        if msg['status_code'] == 0:
            # Send start command to SIGNALING socket
            signaling_ws.send(json.dumps({
                "msg_type": 7,
                "rtms_stream_id": stream_id
            }))
            print("Media streaming started")
    
    elif msg_type == 12:  # KEEP_ALIVE_REQ
        media_ws.send(json.dumps({
            "msg_type": 13,
            "timestamp": msg['timestamp']
        }))
    
    elif msg_type == 14:  # MEDIA_DATA_AUDIO
        handle_audio_data(msg)
    
    elif msg_type == 15:  # MEDIA_DATA_VIDEO
        handle_video_data(msg)
    
    elif msg_type == 17:  # MEDIA_DATA_TRANSCRIPT
        handle_transcript(msg)
```

**Go:**

```go
func handleMediaMessage(mediaConn, signalingConn *websocket.Conn, data []byte, streamID string) {
    var msg map[string]interface{}
    json.Unmarshal(data, &msg)
    
    msgType := int(msg["msg_type"].(float64))
    
    switch msgType {
    case 4: // MEDIA_HANDSHAKE_RESP
        if statusCode, ok := msg["status_code"].(float64); ok && statusCode == 0 {
            // Send start command to SIGNALING socket
            signalingConn.WriteJSON(map[string]interface{}{
                "msg_type":       7,
                "rtms_stream_id": streamID,
            })
        }
    
    case 12: // KEEP_ALIVE_REQ
        mediaConn.WriteJSON(map[string]interface{}{
            "msg_type":  13,
            "timestamp": msg["timestamp"],
        })
    
    case 14: // MEDIA_DATA_AUDIO
        handleAudioData(msg)
    
    case 15: // MEDIA_DATA_VIDEO
        handleVideoData(msg)
    
    case 17: // MEDIA_DATA_TRANSCRIPT
        handleTranscript(msg)
    }
}
```

---

### 7. Process Media Data

Media socket will now receive `msg_type: 14` (audio), `15` (video), `17` (transcript), etc.

**JavaScript:**

```javascript
const fs = require('fs');

function handleAudioData(msg) {
  // Decode base64 to raw PCM
  const pcmBuffer = Buffer.from(msg.content, 'base64');
  
  // Example: Save to file
  fs.appendFileSync(`audio_${msg.user_id}.pcm`, pcmBuffer);
  
  console.log(`Audio from ${msg.user_name}: ${pcmBuffer.length} bytes`);
}

function handleVideoData(msg) {
  // Decode base64 to H.264 NAL units
  const h264Buffer = Buffer.from(msg.content, 'base64');
  
  // Example: Save to file
  fs.appendFileSync(`video_${msg.user_id}.h264`, h264Buffer);
  
  console.log(`Video from ${msg.user_name}: ${h264Buffer.length} bytes`);
}

function handleTranscript(msg) {
  console.log(`[${msg.user_name}]: ${msg.content}`);
  
  // Save to file
  const line = `${msg.timestamp} [${msg.user_name}]: ${msg.content}\n`;
  fs.appendFileSync('transcript.txt', line);
}
```

**Python:**

```python
import base64

def handle_audio_data(msg):
    # Decode base64 to raw PCM
    pcm_data = base64.b64decode(msg['content'])
    
    # Example: Save to file
    with open(f"audio_{msg['user_id']}.pcm", 'ab') as f:
        f.write(pcm_data)
    
    print(f"Audio from {msg['user_name']}: {len(pcm_data)} bytes")

def handle_video_data(msg):
    # Decode base64 to H.264 NAL units
    h264_data = base64.b64decode(msg['content'])
    
    # Example: Save to file
    with open(f"video_{msg['user_id']}.h264", 'ab') as f:
        f.write(h264_data)
    
    print(f"Video from {msg['user_name']}: {len(h264_data)} bytes")

def handle_transcript(msg):
    print(f"[{msg['user_name']}]: {msg['content']}")
    
    # Save to file
    with open('transcript.txt', 'a') as f:
        f.write(f"{msg['timestamp']} [{msg['user_name']}]: {msg['content']}\n")
```

**Go:**

```go
import (
    "encoding/base64"
    "fmt"
    "os"
)

func handleAudioData(msg map[string]interface{}) {
    content := msg["content"].(string)
    pcmData, _ := base64.StdEncoding.DecodeString(content)
    
    // Save to file
    userID := int(msg["user_id"].(float64))
    f, _ := os.OpenFile(fmt.Sprintf("audio_%d.pcm", userID), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
    f.Write(pcmData)
    f.Close()
    
    fmt.Printf("Audio from %s: %d bytes\n", msg["user_name"], len(pcmData))
}

func handleVideoData(msg map[string]interface{}) {
    content := msg["content"].(string)
    h264Data, _ := base64.StdEncoding.DecodeString(content)
    
    // Save to file
    userID := int(msg["user_id"].(float64))
    f, _ := os.OpenFile(fmt.Sprintf("video_%d.h264", userID), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
    f.Write(h264Data)
    f.Close()
    
    fmt.Printf("Video from %s: %d bytes\n", msg["user_name"], len(h264Data))
}

func handleTranscript(msg map[string]interface{}) {
    userName := msg["user_name"].(string)
    content := msg["content"].(string)
    timestamp := int64(msg["timestamp"].(float64))
    
    fmt.Printf("[%s]: %s\n", userName, content)
    
    // Save to file
    f, _ := os.OpenFile("transcript.txt", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
    f.WriteString(fmt.Sprintf("%d [%s]: %s\n", timestamp, userName, content))
    f.Close()
}
```

---

### 8. Handle Keep-Alive (Critical)

Both sockets send `msg_type: 12` periodically. **Must respond** with:

```json
{
  "msg_type": 13,
  "timestamp": <same_timestamp_from_request>
}
```

**Failure to respond will close the connection.**

This is already shown in the message handlers above. The key points:
- Both signaling AND media sockets send keep-alive
- You must respond to BOTH
- Use the exact same timestamp from the request
- Response should be immediate (within a few seconds)

---

### 9. Handle Cleanup

On `meeting.rtms_stopped` webhook, close both WebSocket connections gracefully.

**JavaScript:**

```javascript
app.post('/webhook', (req, res) => {
  const { event, payload } = req.body;
  
  if (event === 'meeting.rtms_stopped') {
    const { meeting_uuid } = payload.object;
    cleanup(meeting_uuid);
  }
  
  res.status(200).send('OK');
});

function cleanup(meetingUuid) {
  // Close WebSocket connections
  if (mediaWs) {
    mediaWs.close();
    mediaWs = null;
  }
  if (signalingWs) {
    signalingWs.close();
    signalingWs = null;
  }
  
  console.log(`Cleaned up meeting: ${meetingUuid}`);
}
```

**Python:**

```python
@app.route('/webhook', methods=['POST'])
def webhook():
    data = request.json
    event = data.get('event')
    
    if event == 'meeting.rtms_stopped':
        meeting_uuid = data['payload']['object']['meeting_uuid']
        cleanup(meeting_uuid)
    
    return 'OK', 200

def cleanup(meeting_uuid):
    global media_ws, signaling_ws
    
    if media_ws:
        media_ws.close()
        media_ws = None
    if signaling_ws:
        signaling_ws.close()
        signaling_ws = None
    
    print(f"Cleaned up meeting: {meeting_uuid}")
```

**Go:**

```go
var (
    mediaConn     *websocket.Conn
    signalingConn *websocket.Conn
)

func webhookHandler(w http.ResponseWriter, r *http.Request) {
    var payload WebhookPayload
    json.NewDecoder(r.Body).Decode(&payload)
    
    switch payload.Event {
    case "meeting.rtms_started":
        // ... start handling
    case "meeting.rtms_stopped":
        cleanup(payload.Payload.Object.MeetingUUID)
    }
    
    w.WriteHeader(http.StatusOK)
}

func cleanup(meetingUUID string) {
    if mediaConn != nil {
        mediaConn.Close()
        mediaConn = nil
    }
    if signalingConn != nil {
        signalingConn.Close()
        signalingConn = nil
    }
    
    fmt.Printf("Cleaned up meeting: %s\n", meetingUUID)
}
```

---

## Message Types Reference

### Signaling Socket

| msg_type | Name | Direction | Description |
|----------|------|-----------|-------------|
| 1 | SIGNALING_HANDSHAKE_REQ | Client → Server | Initial authentication |
| 2 | SIGNALING_HANDSHAKE_RESP | Server → Client | Returns media server URL |
| 7 | START_MEDIA_REQ | Client → Server | Request to start streaming |
| 12 | KEEP_ALIVE_REQ | Server → Client | Keep-alive ping |
| 13 | KEEP_ALIVE_RESP | Client → Server | Keep-alive response |

### Media Socket

| msg_type | Name | Direction | Description |
|----------|------|-----------|-------------|
| 3 | MEDIA_HANDSHAKE_REQ | Client → Server | Media authentication |
| 4 | MEDIA_HANDSHAKE_RESP | Server → Client | Handshake confirmation |
| 12 | KEEP_ALIVE_REQ | Server → Client | Keep-alive ping |
| 13 | KEEP_ALIVE_RESP | Client → Server | Keep-alive response |
| 14 | MEDIA_DATA_AUDIO | Server → Client | Audio data packet |
| 15 | MEDIA_DATA_VIDEO | Server → Client | Video data packet |
| 16 | MEDIA_DATA_SHARE_SCREEN | Server → Client | Screen share data |
| 17 | MEDIA_DATA_TRANSCRIPT | Server → Client | Transcript text |
| 18 | MEDIA_DATA_CHAT | Server → Client | Chat message |

## Media Type Flags

The `media_type` field is a bitmask:

| Flag | Value | Description |
|------|-------|-------------|
| Audio | 1 | Receive audio streams |
| Video | 2 | Receive video streams |
| Screen Share | 4 | Receive screen share |
| Chat | 8 | Receive chat messages |
| Transcript | 16 | Receive transcripts |
| **All** | **32** | Receive all media types |

Combine flags: `audio + video + transcript = 1 + 2 + 16 = 19`

## Media Parameters Reference

### Audio Parameters

| Parameter | Options | Description |
|-----------|---------|-------------|
| `content_type` | 2 (RAW_AUDIO) | Audio format type |
| `sample_rate` | 0 (8kHz), 1 (16kHz), 2 (32kHz), 3 (48kHz) | Sample rate |
| `channel` | 1 (MONO), 2 (STEREO) | Audio channels |
| `codec` | 1 (L16 PCM) | Audio codec |
| `data_opt` | 1 (MIXED), 2 (SEPARATE) | Stream type |
| `send_rate` | 50-200 | Chunk size in ms |

### Video Parameters

| Parameter | Options | Description |
|-----------|---------|-------------|
| `content_type` | 3 (RAW_VIDEO) | Video format type |
| `codec` | 7 (H264) | Video codec |
| `resolution` | 1 (360p), 2 (720p), 3 (1080p) | Video resolution |
| `fps` | 15, 25, 30 | Frames per second |

See [MEDIA_PARAMETERS.md](./MEDIA_PARAMETERS.md) for complete reference.

## Complete Working Example

Here's a minimal but complete implementation in each language:

### JavaScript (Complete)

```javascript
const express = require('express');
const crypto = require('crypto');
const WebSocket = require('ws');
const fs = require('fs');

const app = express();
app.use(express.json());

const CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

let signalingWs = null;
let mediaWs = null;

function generateSignature(meetingUuid, streamId) {
  const message = `${CLIENT_ID},${meetingUuid},${streamId}`;
  return crypto.createHmac('sha256', CLIENT_SECRET)
    .update(message)
    .digest('hex');
}

app.post('/webhook', (req, res) => {
  const { event, payload } = req.body;
  
  if (event === 'meeting.rtms_started') {
    const { meeting_uuid, rtms_stream_id, server_urls } = payload.object;
    connectToSignaling(meeting_uuid, rtms_stream_id, server_urls);
  } else if (event === 'meeting.rtms_stopped') {
    cleanup();
  }
  
  res.status(200).send('OK');
});

function connectToSignaling(meetingUuid, streamId, serverUrl) {
  signalingWs = new WebSocket(serverUrl);
  
  signalingWs.on('open', () => {
    signalingWs.send(JSON.stringify({
      msg_type: 1,
      protocol_version: 1,
      meeting_uuid: meetingUuid,
      rtms_stream_id: streamId,
      sequence: Math.floor(Math.random() * 1000000),
      signature: generateSignature(meetingUuid, streamId),
      buffer_data: false
    }));
  });
  
  signalingWs.on('message', (data) => {
    const msg = JSON.parse(data);
    
    if (msg.msg_type === 2 && msg.status_code === 0) {
      connectToMedia(msg.media_server.server_urls.all, meetingUuid, streamId);
    } else if (msg.msg_type === 12) {
      signalingWs.send(JSON.stringify({ msg_type: 13, timestamp: msg.timestamp }));
    }
  });
}

function connectToMedia(mediaUrl, meetingUuid, streamId) {
  mediaWs = new WebSocket(mediaUrl);
  
  mediaWs.on('open', () => {
    mediaWs.send(JSON.stringify({
      msg_type: 3,
      protocol_version: 1,
      meeting_uuid: meetingUuid,
      rtms_stream_id: streamId,
      signature: generateSignature(meetingUuid, streamId),
      media_type: 32,
      payload_encryption: false,
      media_params: {
        audio: { content_type: 2, sample_rate: 1, channel: 1, codec: 1, data_opt: 1, send_rate: 100 },
        video: { content_type: 3, codec: 7, resolution: 2, fps: 25 }
      }
    }));
  });
  
  mediaWs.on('message', (data) => {
    const msg = JSON.parse(data);
    
    if (msg.msg_type === 4 && msg.status_code === 0) {
      signalingWs.send(JSON.stringify({ msg_type: 7, rtms_stream_id: streamId }));
    } else if (msg.msg_type === 12) {
      mediaWs.send(JSON.stringify({ msg_type: 13, timestamp: msg.timestamp }));
    } else if (msg.msg_type === 14) {
      fs.appendFileSync('audio.pcm', Buffer.from(msg.content, 'base64'));
    } else if (msg.msg_type === 15) {
      fs.appendFileSync('video.h264', Buffer.from(msg.content, 'base64'));
    } else if (msg.msg_type === 17) {
      console.log(`[${msg.user_name}]: ${msg.content}`);
    }
  });
}

function cleanup() {
  if (mediaWs) { mediaWs.close(); mediaWs = null; }
  if (signalingWs) { signalingWs.close(); signalingWs = null; }
}

app.listen(3000, () => console.log('Listening on port 3000'));
```

---

## Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - High-level overview & implementation approaches
- [MEDIA_PARAMETERS.md](./MEDIA_PARAMETERS.md) - Audio/video configuration options
- [PRODUCTION.md](./PRODUCTION.md) - Distributed architecture & scaling guide
- [library/javascript/README.md](./library/javascript/README.md) - RTMSManager library documentation
