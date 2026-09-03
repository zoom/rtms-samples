# RTMS Reconnection & Chaos Mode

This sample demonstrates how to handle RTMS connection failures and reconnect using raw WebSockets. It covers all three reconnection scenarios defined in the [Zoom RTMS docs](https://developers.zoom.us/docs/rtms/meetings/work-with-streams/#failover-and-reconnection) and includes a "chaos mode" that deliberately causes disconnections so you can observe the reconnection flow.

## The Three Reconnection Scenarios

### Scenario 1: RTMS Server Failure

The Zoom RTMS server goes down. A replacement server spins up and sends a **new `meeting.rtms_started`** webhook with fresh `server_urls`.

**What to do:** Close old connections. Reconnect both signaling and media using the new URLs.

### Scenario 2: Signal Connection Down

Your app's signaling WebSocket drops (network issue, keep-alive timeout, etc.). Since signaling controls the session, the RTMS server interrupts **both** signaling and media connections and sends a **`meeting.rtms_interrupted`** webhook. For this to work, your app must be subscribed to that webhook event.

**What to do:** Reconnect both signaling and media. The server waits ~60 seconds before giving up.

### Scenario 3: Media Connection Down Only

Only the media WebSocket drops while signaling stays alive. The RTMS server sends a **`MEDIA_CONNECTION_INTERRUPTED`** event (event_type 7) through the still-active signaling channel.

**What to do:** Reconnect only the media WebSocket. The server waits ~30 seconds before giving up.

## Prerequisites

- Node.js v18 or higher
- A Zoom App with RTMS event subscriptions and scopes configured ([Add RTMS features to your app](https://developers.zoom.us/docs/rtms/meetings/add-features/))
- A public webhook URL (use [ngrok](https://ngrok.com/) or similar for local development)

## Installation

```bash
npm install
```

## Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```env
ZOOM_CLIENT_ID=your_zoom_client_id
ZOOM_CLIENT_SECRET=your_zoom_client_secret
ZOOM_SECRET_TOKEN=your_zoom_secret_token
PORT=3000
WEBHOOK_PATH=/webhook

# Chaos Mode: keep-alive suppression (works during silence only)
CHAOS_SUPPRESS_SIGNALING_KEEPALIVE=false
CHAOS_SUPPRESS_MEDIA_KEEPALIVE=false

# Chaos Mode: force-disconnect timer in seconds (works anytime, recommended)
CHAOS_FORCE_DISCONNECT_SIGNALING_AFTER_SEC=0
CHAOS_FORCE_DISCONNECT_MEDIA_AFTER_SEC=0
```

## Running

**Normal mode** (handles reconnection if it happens naturally):

```bash
npm start
```

**Chaos mode — test media reconnection** (Scenario 3):

```bash
CHAOS_FORCE_DISCONNECT_MEDIA_AFTER_SEC=15 npm start
```

**Chaos mode — test signaling reconnection** (Scenario 2):

```bash
CHAOS_FORCE_DISCONNECT_SIGNALING_AFTER_SEC=15 npm start
```

Then start a Zoom meeting with RTMS enabled. The console will show the full lifecycle.

## Code Walkthrough

The entire implementation lives in a single file ([index.js](index.js)) organized into clearly labeled sections. This walkthrough follows the connection lifecycle from start to finish, then covers each reconnection scenario.

### Protocol Constants

All RTMS message types, event types, stream states, and stop reasons are defined as named constants so you never see bare numbers in the logic.

> See [index.js:82-120](index.js#L82-L120) — `MSG_TYPE`, `EVENT_TYPE`, `STREAM_STATE`, and `STOP_REASON` definitions.

### Connection State

Each active RTMS stream is tracked in an `activeStreams` Map keyed by `rtms_stream_id`. The per-stream state object holds both WebSocket handles, the current lifecycle state (`CONNECTING` / `STREAMING` / `RECONNECTING` / `STOPPED`), reconnection attempt count for backoff, and chaos mode diagnostics.

> See [index.js:127-156](index.js#L127-L156) — `activeStreams` Map and `createStreamConnection()`.

### Step 1: Webhook Receives `meeting.rtms_started`

Everything begins when Zoom sends a `meeting.rtms_started` webhook containing the `meeting_uuid`, `rtms_stream_id`, and `server_urls`. The webhook handler checks if this stream already exists — if it does, that's Scenario 1 (server failure). Otherwise, it creates a new connection state and kicks off the signaling handshake.

> See [index.js:824-838](index.js#L824-L838) — webhook routing for `meeting.rtms_started`.

### Step 2: Signaling Handshake

The app opens a WebSocket to the signaling server URL from the webhook and sends a signed handshake request (`msg_type: 1`) with `buffer_data: false` so initial buffered audio is dropped while the signaling connection is established. The signature is an HMAC-SHA256 of `"client_id,meeting_uuid,rtms_stream_id"` using your client secret.

> See [index.js:219-241](index.js#L219-L241) — `connectToSignalingWebSocket()` and handshake payload.
>
> See [index.js:168-171](index.js#L168-L171) — `generateSignature()`.

### Step 3: Signaling Response — Extract Media URL

The signaling server responds (`msg_type: 2`) with the result and, on success, provides the media server URL. The app extracts the transcript-specific URL (or falls back to the "all" URL) and connects to the media server.

> See [index.js:289-303](index.js#L289-L303) — handshake response handling and media URL extraction.

### Step 4: Media Handshake

The app opens a second WebSocket to the media server and sends a media handshake (`msg_type: 3`) requesting transcript data (`media_type: 8`). This sample requests only transcripts to keep things simple — text output is easy to verify in console logs.

> See [index.js:468-494](index.js#L468-L494) — `connectToMediaWebSocket()` and media handshake payload.

### Step 5: CLIENT_READY_ACK

After the media server confirms the connection (`msg_type: 4`), the app sends a `CLIENT_READY_ACK` (`msg_type: 7`) back to the **signaling** socket (not the media socket). This tells the RTMS server the full handshake is complete and the app is ready to receive data.

> See [index.js:548-565](index.js#L548-L565) — media handshake response handling and CLIENT_READY_ACK send.

### Step 6: Receiving Transcripts

Transcript data arrives on the media socket as `msg_type: 17` with the participant name and text content.

> See [index.js:603-610](index.js#L603-L610) — transcript data handler.

### Step 7: Keep-Alive Handling

Both sockets receive keep-alive pings (`msg_type: 12`) every ~10 seconds when no data is flowing. The app must respond with `msg_type: 13` to stay connected. Missing 3 consecutive pings (~30 seconds) triggers server-side disconnection.

> See [index.js:311-331](index.js#L311-L331) — signaling keep-alive handler (with chaos mode suppression).
>
> See [index.js:577-596](index.js#L577-L596) — media keep-alive handler (with chaos mode suppression).

### Reconnection: Scenario 1 — RTMS Server Failure

**Trigger:** A `meeting.rtms_started` webhook arrives for a `streamId` that already exists in `activeStreams`. This means the original RTMS server went down and a new one has spun up.

**Action:** Close old signaling and media sockets, create a fresh connection state with the new `server_urls`, and start the signaling handshake from scratch.

> See [index.js:828-830](index.js#L828-L830) — webhook detection (stream already exists).
>
> See [index.js:641-662](index.js#L641-L662) — `handleServerFailureReconnect()`.

### Reconnection: Scenario 2 — Signal Connection Down

**Trigger:** A `meeting.rtms_interrupted` webhook arrives. The signaling socket dropped, so the RTMS server terminated both connections.

**Action:** Close any lingering sockets, increment the reconnect attempt counter, and schedule `connectToSignalingWebSocket()` after an exponential backoff delay. The full handshake (signaling + media + CLIENT_READY_ACK) runs again from the beginning.

> See [index.js:847-852](index.js#L847-L852) — webhook routing for `meeting.rtms_interrupted`.
>
> See [index.js:682-721](index.js#L682-L721) — `handleSignalingInterruptedReconnect()`.

### Reconnection: Scenario 3 — Media Connection Down Only

**Trigger:** The signaling channel delivers an `EVENT_UPDATE` (`msg_type: 6`) with `event_type: 7` (`MEDIA_CONNECTION_INTERRUPTED`). The signaling connection is still alive — only the media socket dropped.

**Action:** Close only the old media socket and schedule `connectToMediaWebSocket()` after a backoff delay. Signaling stays up, so no re-handshake is needed on that side.

> See [index.js:385-392](index.js#L385-L392) — `MEDIA_CONNECTION_INTERRUPTED` detection inside `handleEventUpdate()`.
>
> See [index.js:739-759](index.js#L739-L759) — `handleMediaOnlyReconnect()`.

A secondary trigger path exists via `STREAM_STATE_UPDATE` (`msg_type: 8`) with `state: 2` (INTERRUPTED) and `reason: 14` (DATA_CONNECTION_INTERRUPTED). The code guards against double-reconnect if both signals arrive.

> See [index.js:425-443](index.js#L425-L443) — stream state interrupted handler with duplicate guard.

### Why No Auto-Reconnect on Close

The app does **not** auto-reconnect when a WebSocket close event fires. Instead, it waits for explicit signals from Zoom — webhooks for Scenarios 1 and 2, signaling events for Scenario 3. This matches the documented Zoom reconnection contract and prevents duplicate connections.

> See [index.js:264-272](index.js#L264-L272) — signaling close handler (no auto-reconnect, with explanation).
>
> See [index.js:521-527](index.js#L521-L527) — media close handler (same approach).

### Exponential Backoff

Reconnection attempts use exponential backoff starting at 3 seconds and doubling each attempt, capped at 30 seconds. The counter resets on each successful handshake.

> See [index.js:177-182](index.js#L177-L182) — `getReconnectDelay()`.

## Chaos Mode

Chaos mode deliberately causes disconnections so you can observe the full reconnection flow without waiting for a real network failure. There are two mechanisms:

### Force-Disconnect Timer (recommended)

Forcibly closes a WebSocket after a configurable number of seconds. This works reliably regardless of meeting activity — even while someone is actively speaking.

| Environment Variable | What It Does | Reconnection Triggered |
|---|---|---|
| `CHAOS_FORCE_DISCONNECT_SIGNALING_AFTER_SEC=15` | Closes signaling socket after 15s | Scenario 2 — both sockets reconnect |
| `CHAOS_FORCE_DISCONNECT_MEDIA_AFTER_SEC=15` | Closes media socket after 15s | Scenario 3 — only media socket reconnects |

> See [index.js:243-255](index.js#L243-L255) — signaling force-disconnect timer.
>
> See [index.js:496-508](index.js#L496-L508) — media force-disconnect timer.

### Keep-Alive Suppression

Ignores keep-alive pings so the server detects the connection as dead. The RTMS server sends keep-alive pings every ~10 seconds **when no data is flowing**. If your app misses 3 consecutive pings (~30 seconds), the server terminates the connection.

> **Note:** Keep-alive pings are only sent during idle periods (silence). If someone is speaking, the server won't send keep-alives and this mode won't trigger a disconnection. Use the force-disconnect timer instead.

| Environment Variable | What It Does | Reconnection Triggered |
|---|---|---|
| `CHAOS_SUPPRESS_SIGNALING_KEEPALIVE=true` | Ignores signaling keep-alive pings | Scenario 2 — both sockets reconnect |
| `CHAOS_SUPPRESS_MEDIA_KEEPALIVE=true` | Ignores media keep-alive pings | Scenario 3 — only media socket reconnects |

After reconnection, chaos mode stays active, so the disconnect/reconnect cycle repeats. This lets you observe multiple reconnection rounds. Restart the server with the flags disabled to stop.

## What to Expect in the Console

### Normal Flow

```
[WEBHOOK]    New stream detected. Establishing initial connection...
[SIGNALING]  WebSocket opened. Sending handshake (msg_type: 1)...
[SIGNALING]  Handshake successful. Media server URL: wss://...
[MEDIA]      WebSocket opened. Sending media handshake (msg_type: 3)...
[MEDIA]      Media handshake successful.
[MEDIA]      Sending CLIENT_READY_ACK (msg_type: 7) to signaling server...
[MEDIA]      Ready to receive transcript data!
[TRANSCRIPT] [John Smith]: Hello everyone...
```

### Chaos Mode — Media Disconnection (Scenario 3)

```
[TRANSCRIPT] [John Smith]: Hello everyone...
[CHAOS]      Will FORCE-CLOSE media socket in 15s...
[TRANSCRIPT] [John Smith]: Let me share some updates...
[CHAOS]      Force-closing media socket NOW (after 15s).
[CHAOS]      This simulates a network failure. Expect MEDIA_CONNECTION_INTERRUPTED → Scenario 3.
[MEDIA]      WebSocket closed (code: 1006).
[RECONNECT]  ========================================
[RECONNECT]  SCENARIO 3: MEDIA_CONNECTION_INTERRUPTED
[RECONNECT]  Signaling is still alive. Reconnecting ONLY the media socket.
[RECONNECT]  ========================================
[RECONNECT]  Reconnecting media in 3000ms (attempt #1)...
[MEDIA]      Connecting to media server: wss://...
[MEDIA]      Media handshake successful.
[TRANSCRIPT] [John Smith]: ...continuing the conversation...
```

### Chaos Mode — Signaling Disconnection (Scenario 2)

```
[TRANSCRIPT] [John Smith]: Hello everyone...
[CHAOS]      Will FORCE-CLOSE signaling socket in 15s...
[TRANSCRIPT] [John Smith]: Let me share some updates...
[CHAOS]      Force-closing signaling socket NOW (after 15s).
[CHAOS]      This simulates a network failure. Expect meeting.rtms_interrupted webhook → Scenario 2.
[SIGNALING]  WebSocket closed (code: 1006).
[MEDIA]      WebSocket closed (code: 1006).
[WEBHOOK]    meeting.rtms_interrupted
[RECONNECT]  ========================================
[RECONNECT]  SCENARIO 2: SIGNAL CONNECTION INTERRUPTED
[RECONNECT]  Must re-establish BOTH signaling and media connections.
[RECONNECT]  ========================================
[RECONNECT]  Reconnecting in 3000ms (attempt #1)...
[SIGNALING]  Handshake successful. Media server URL: wss://...
[MEDIA]      Media handshake successful.
[TRANSCRIPT] [John Smith]: ...back online...
```

## Message Types Used

| msg_type | Name | Direction | Purpose |
|---|---|---|---|
| 1 | `SIGNALING_HANDSHAKE_REQ` | App → Signaling | Initiate signaling connection |
| 2 | `SIGNALING_HANDSHAKE_RESP` | Signaling → App | Handshake result + media URLs |
| 3 | `MEDIA_HANDSHAKE_REQ` | App → Media | Initiate media connection |
| 4 | `MEDIA_HANDSHAKE_RESP` | Media → App | Confirm media parameters |
| 6 | `EVENT_UPDATE` | Signaling → App | In-meeting events (including interruptions) |
| 7 | `CLIENT_READY_ACK` | App → Signaling | Ready to receive data |
| 8 | `STREAM_STATE_UPDATE` | Signaling → App | Stream lifecycle changes |
| 9 | `SESSION_STATE_UPDATE` | Signaling → App | Per-participant session changes |
| 12 | `KEEP_ALIVE_REQ` | Server → App | Connection health check |
| 13 | `KEEP_ALIVE_RESP` | App → Server | Keep-alive response |
| 17 | `MEDIA_DATA_TRANSCRIPT` | Media → App | Transcript text |

## Troubleshooting

- **No webhook events arriving**: Make sure your webhook URL is publicly accessible and registered in your Zoom app settings. Use `ngrok http 3000` for local development.
- **Handshake fails with status_code 15 (INVALID_SIGNATURE)**: Double-check your `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET` in `.env`.
- **No transcripts appearing**: Ensure Zoom closed captions are enabled in the meeting and your app has the transcript RTMS scope.
- **Keep-alive suppression doesn't trigger disconnection**: Keep-alive pings are only sent during silence. If someone is speaking, use the force-disconnect timer instead (`CHAOS_FORCE_DISCONNECT_MEDIA_AFTER_SEC=15`).

## Docker

The project runs the RTMS reconnection and failure-injection test service. Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f rtms_api/reconnection_and_chaos_mode_js/Dockerfile -t rtms-rtms_api-reconnection_and_chaos_mode_js .
docker run --rm --env-file rtms_api/reconnection_and_chaos_mode_js/.env -p 3000:3000 rtms-rtms_api-reconnection_and_chaos_mode_js
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.

## Webhook Delivery Authentication

Normal Zoom webhook deliveries are verified against the exact raw request body using
`x-zm-signature` and `x-zm-request-timestamp`. Configure `ZOOM_SECRET_TOKEN` with the
Marketplace app's webhook Secret Token. Requests with missing, invalid, or stale
signatures are rejected; the default replay window is 300 seconds and can be changed
with `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`.
