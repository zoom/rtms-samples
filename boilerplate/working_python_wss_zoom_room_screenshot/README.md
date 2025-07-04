# Zoom RTMS Zoom Room Sample (Python)

This is a sample Python application demonstrating how to capture Zoom Room video frames via the RTMS (Real-Time Media Service) WebSocket. It listens for meeting events, connects to the signaling and media servers, and saves decoded video frames for analysis.

---

## 🔧 Requirements

- Python 3.7+
- Zoom Meeting with:
  - **"Join before host" enabled**
  - Meeting ID and passcode
- Zoom Room device:
  - **Camera turned on by default**
- Zoom App credentials:
  - **S2S App** for API access
  - **General App** (or JWT-style) for RTMS signaling/media

---

## 📦 Installation

```bash
pip install -r requirements.txt
```

Create a `.env` file with the following:

```env
PORT=3000
LOG_LEVEL=DEBUG

ZOOM_SECRET_TOKEN=your_token
ZM_CLIENT_ID=your_oauth_client_id
ZM_CLIENT_SECRET=your_oauth_client_secret

S2S_ZM_CLIENT_ID=your_s2s_client_id
S2S_ZM_CLIENT_SECRET=your_s2s_client_secret
ZOOM_ACCOUNT_ID=your_account_id

ZOOM_MEETING_NUMBER=your_meeting_number
ZOOM_MEETING_PASSCODE=your_passcode

ZOOM_EVENT_WS_BASE=wss://your-zoom-websocket-url
```

---

## 🚀 How It Works

1. **WebSocket connections**
   - `Zoom Event WS`: Detects `meeting.rtms_started` events
   - `Signaling WS`: Negotiates with Zoom infrastructure
   - `Media WS`: Streams actual audio/video frames

2. **Frame Capture**
   - Uses `msg_type == 15` from media socket to receive base64 JPG video frames
   - Saves **up to 3 frames** per user under `recordings/{user_name}_{user_id}/`

3. **Zoom Room Management**
   - Uses Zoom API to join Zoom Rooms to the specified meeting
   - Each room leaves automatically after **30 seconds**
   - Retry logic persists failures in `retry_rooms.json`

4. **Logging**
   - Detailed logging for WebSocket events, token fetch, room joins/leaves, and frame decoding

---

## 🧠 Good to Know

- **Edge cases like reconnection on WebSocket disconnection are not handled**
- `save_video_frame()` is a great place to call **CV or AI pipelines**
- `run_zoom_room_joiner()` is triggered after the media stream handshake
- You can tweak:
  - `MAX_FILES_PER_USER = 3`
  - `leave delay = 30s`

---

## 🔐 Token Strategy

- **S2S credentials** are used for Zoom Room API (join/leave)
- **OAuth credentials** (or general app credentials) are used for RTMS/WebSocket signaling

---

## 📁 File Output

Captured frames are saved to:

```
recordings/
  └── {user_name}_{user_id}/
        ├── 1750690000000.jpg 
        └── ...
```

---

## ⚠️ Limitations

- No retry for WebSocket disconnection
- No audio or transcript processing
- Requires Zoom Room to auto-start camera
- Requires RTMS to auto-start (setting in zoom.us)
- Meeting host should NOT join to allow active speaker capture from Zoom Room

---

