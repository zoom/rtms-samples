# RTMS Consent App

**Enterprise demonstration of consent-based access to Realtime Meeting Streaming (RTMS) transcripts in Zoom.**

This Zoom in-meeting application ensures that RTMS transcript access only begins when all participants have provided explicit consent. The app automatically pauses when new participants join and resumes only after they also consent. The app also logs consent status for each participant in real-time.

![RTMS Consent app running in the meeting](https://github.com/zoom/rtms-samples/blob/main/zoom_apps/prompt_for_user_consent_js/screenshots/screenshot.png)

---

## Features

1. **Unanimous Consent Requirement** - RTMS transcript access requires explicit agreement from all meeting participants
2. **Real-Time Participant Tracking** - Automatically detects when participants join or leave the meeting
3. **Dynamic Pause/Resume** - RTMS pauses when new participants join and resumes after they consent
4. **Host Dashboard** - Full visibility into participant list with color-coded consent status
5. **Guest Mode** - Simple consent-only interface for meeting participants
6. **Live State Synchronization** - WebSocket-powered real-time updates across all app instances
7. **Automatic App Invitations** - New participants automatically receive invitations to open the app
8. **Real-Time Transcript Capture** - Direct integration with Zoom's RTMS API for live transcript streaming

---

## Architecture

The application uses a modern microservices architecture with four main components:

```
┌─────────────────────────────────────────────────────────┐
│                    Zoom Client                          │
│  ┌──────────────┐              ┌──────────────┐        │
│  │ Host Mode    │◄────────────►│  Guest Mode  │        │
│  │ (Dashboard)  │  WebSocket   │  (Consent)   │        │
│  └──────────────┘              └──────────────┘        │
└────────────┬──────────────────────────┬─────────────────┘
             │         HTTPS/REST       │
             └──────────┬───────────────┘
                        │
         ┌──────────────┴──────────────┐
         │   Backend Server            │
         │   (Node.js/Express)         │
         │   - REST API                │
         │   - WebSocket Server        │
         │   - State Management        │
         │   - RTMS Control            │
         └──────────┬──────────────────┘
                    │
         ┌──────────┴──────────┐
         │                     │
         ▼                     ▼
┌─────────────────┐   ┌─────────────────┐
│  Redis          │   │  RTMS Server    │
│  - Sessions     │   │  - WebSocket    │
│  - Consent State│   │  - Transcripts  │
└─────────────────┘   └─────────────────┘
```

**Technology Stack:**
- **Frontend:** React 17+ with Zoom Apps SDK
- **Backend:** Node.js, Express 4.x, Socket.IO
- **State Management:** Redis with encrypted storage
- **RTMS:** @zoom/rtms SDK for real-time transcript capture
- **Deployment:** Docker Compose multi-container setup

---

## Prerequisites

Before you begin, ensure you have the following:

1. **Zoom Account** with App Marketplace access
2. **Node.js** 18+ installed
3. **Docker Desktop** installed and running
4. **ngrok** for local development tunnel
5. **Zoom App** created in the Marketplace with the following configuration:
   - **App Type:** Meeting App (Zoom Apps SDK)
   - **Domain Allowlist:** Must include `appssdk.zoom.us`
   - **OAuth Redirect URL:** Configured before installation
   - **SDK Capabilities:** `getMeetingContext`, `getMeetingUUID`, `getUserContext`, `getMeetingParticipants`, `onParticipantChange`, `sendAppInvitationToAllParticipants`, `startRTMS`, `stopRTMS`
   - **Event Subscriptions:** `meeting.rtms_started`, `meeting.rtms_stopped`, `meeting.participant_joined`, `meeting.participant_left`, `endpoint.url_validation`
   - **RTMS Scopes:** At minimum `meeting:read:meeting_transcript`

---

## Getting Started

### 1. Clone the Repository

```bash
git clone <your-repo-url>
cd rtms-consent-app
```

### 2. Configure Environment Variables

Copy the example environment file and generate secure secrets:

```bash
# Copy environment template
cp .env.example .env

# Generate session secret (32 bytes)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate Redis encryption key (16 bytes = 32 hex chars)
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

Edit `.env` and add your values:

```bash
# Zoom App credentials (from Marketplace)
ZOOM_APP_CLIENT_ID=your_client_id
ZOOM_APP_CLIENT_SECRET=your_client_secret

# Security keys (generated above)
SESSION_SECRET=<your_32_byte_hex_string>
REDIS_ENCRYPTION_KEY=<your_32_char_hex_string>

# Public URL (ngrok URL - see next step)
PUBLIC_URL=https://your-ngrok-url.ngrok-free.app
ZOOM_APP_REDIRECT_URI=https://your-ngrok-url.ngrok-free.app/api/zoomapp/auth
```

### 3. Start ngrok Tunnel

```bash
ngrok http 3000
```

Copy the HTTPS URL (e.g., `https://abc123.ngrok-free.app`) and update your `.env` file with the `PUBLIC_URL` and `ZOOM_APP_REDIRECT_URI` values.

### 4. Update Zoom Marketplace URLs

In your Zoom Marketplace app configuration:

1. Navigate to **Basic Information** → **App Credentials**
2. Set **Redirect URL**: `https://your-ngrok-url.ngrok-free.app/api/zoomapp/auth`
3. Navigate to **Features** → **Zoom App SDK**
4. Set **Home URL**: `https://your-ngrok-url.ngrok-free.app/api/zoomapp/home`
5. Set **Webhook URL** (Event Subscriptions): `https://your-ngrok-url.ngrok-free.app/api/webhooks/zoom`

### 5. Install Dependencies

Dependencies are automatically installed by Docker, but if you want to run services locally:

```bash
# Backend dependencies
cd backend && npm install

# Frontend dependencies
cd frontend && npm install

# RTMS server dependencies
cd rtms/sdk && npm install
```

---

## Start the App

### Using Docker Compose (Recommended)

Start all services with a single command:

```bash
# Build and start all services (backend, frontend, redis, rtms)
docker-compose up --build

# Or run in detached mode
docker-compose up -d --build
```

**View logs:**

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f backend
docker-compose logs -f frontend
docker-compose logs -f rtms
```

**Stop services:**

```bash
docker-compose down
```

**Restart individual service:**

```bash
docker-compose restart backend
```

### Using Local Development

Alternatively, run services locally (requires local Redis):

```bash
# Terminal 1: Start Redis
redis-server

# Terminal 2: Start backend
cd backend && npm run dev

# Terminal 3: Start frontend
cd frontend && npm start

# Terminal 4: Start RTMS server
cd rtms/sdk && npm start
```

### Verify the App is Running

1. **Check backend health:**
   ```bash
   curl http://localhost:3000/health
   # Expected: {"status":"ok","timestamp":"...","uptime":...}
   ```

2. **Check Docker services:**
   ```bash
   docker-compose ps
   # Expected: All services showing "Up"
   ```

3. **Open in Zoom:**
   - Start a Zoom meeting
   - Click "Apps" in the meeting toolbar
   - Find and open your app
   - You should see the consent prompt or host dashboard

---

## Customization

### Environment Variables

All customization is done through environment variables in the `.env` file:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Backend server port | `3000` |
| `NODE_ENV` | Environment mode (`development`, `production`) | `development` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `LOG_LEVEL` | Logging verbosity (`error`, `warn`, `info`, `debug`) | `info` |

### Consent Prompt Text

Modify the consent language in:
- `frontend/src/components/ConsentPrompt.jsx` (lines 30-40)

### UI Styling

The app uses Bootstrap 5 for styling. Customize colors and themes in:
- `frontend/src/App.css`
- `frontend/src/index.css`

### RTMS Configuration

Configure RTMS capture settings in:
- `rtms/sdk/index.js` - Transcript processing and storage location
- Default transcript location: `rtms/app/data/transcripts/`

---

## Usage

### For Meeting Hosts

1. **Start the meeting** and open the app from the Apps menu
2. **View the dashboard** showing all participants and their consent status
3. **Monitor RTMS status:**
   - **Active** (green): All participants have consented, transcripts are being captured
   - **Paused** (yellow): Waiting for new participant(s) to consent
   - **Stopped** (red): RTMS is not running

4. **Automatic behavior:**
   - RTMS starts automatically when all participants consent
   - RTMS pauses when new participants join
   - RTMS resumes when new participants provide consent

### For Meeting Participants

1. **Receive app invitation** when joining the meeting (if app is already in use)
2. **Open the app** from the notification or Apps menu
3. **Review consent prompt** explaining what data will be captured
4. **Click "I Agree" or "I Disagree"**
5. **View your consent status** after submission

### Participant Consent Status Badges

- **Green badge:** Participant has agreed to consent
- **Yellow badge:** Participant has not yet responded
- **Red badge:** Participant has declined consent

### RTMS Lifecycle

```
All Participants Consent → RTMS Starts
    ↓
New Participant Joins → RTMS Pauses
    ↓
New Participant Consents → RTMS Resumes
    ↓
Any Participant Declines → RTMS Stops Permanently
```

### Accessing Transcripts

Real-time transcripts are saved to:
```
rtms/app/data/transcripts/
```

Each meeting generates a timestamped transcript file in plain text format.

---

## License

This project is licensed under the MIT License.

Copyright (c) 2025 Zoom Video Communications, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Webhook Delivery Authentication

Normal Zoom webhook deliveries are verified against the exact raw request body using
`x-zm-signature` and `x-zm-request-timestamp`. Configure `ZOOM_SECRET_TOKEN` with the
Marketplace app's webhook Secret Token. Requests with missing, invalid, or stale
signatures are rejected; the default replay window is 300 seconds and can be changed
with `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`.

The internal backend-to-RTMS webhook also requires the same long random
`INTERNAL_WEBHOOK_TOKEN` value on both services.
