# Zoom RTMS Media Receiver (Node.js)

This Node.js example demonstrates how to receive real-time audio, video, screen share, transcript, and chat data from a Zoom meeting using the RTMS (Real-Time Media Streaming) service.
The nodejs server side code connects to Zoom’s RTMS infrastructure via WebSocket, handles webhook events

## Prerequisites

- Node.js v18 or higher
- A Zoom account with RTMS enabled
- Zoom App credentials (Client ID and Client Secret) 
- Zoom Secret Token for webhook validation
- Optional: Zoom Server to Server OAuth credentials for S2S Api calls

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory with the following content:
Refer to .env.example for reference
```
ZOOM_SECRET_TOKEN=your_secret_token
ZM_CLIENT_ID=your_client_id
ZM_CLIENT_SECRET=your_client_secret
PORT=3000
WEBHOOK_PATH=/webhook

S2S_CLIENT_ID=your_s2s_client_id            # optional for S2S auth
S2S_CLIENT_SECRET=your_s2s_client_secret    # optional for S2S auth
ZM_ACCOUNT_ID=your_accountid                # optional for S2S auth
```

## Running the Example

1. Start the server:
```bash
node index.js
```

2. Expose your local server using a tool like ngrok:
```bash
ngrok http 3000
```

3. Set your Zoom App's Event Notification URL to point to your ngrok endpoint, e.g.:
```
https://<your-ngrok-subdomain>.ngrok.io/webhook
```

4. Start a Zoom meeting and initiate RTMS streaming.

## Folder Structure

```
.
├── index.js                  # Main entry point, handles webhook, RTMS start/stop, sets up HTTP+WS
├── config.js                 # Loads and exports environment variables from .env
├── signalingSocket.js        # Handles signaling logic
├── mediaSocket.js            # Handles media logic
├── mediaMessageHandler.js    # Processes RTMS media messages (audio, video, screen, etc.)
├── s2sZoomApiClient.js       # Optional Zoom API client with Server-to-Server OAuth flow
├── frontendWss.js            # WebSocket server for frontend clients (Zoom Apps)
├── public/
│   └── index.ejs             # Zoom App context display
├── recordings/               # Folder to store saved media files (auto-created)
├── .env                      # Secrets and config variables
└── package.json
```

## Flow Diagram

        ┌──────────────┐
        │  index.js    │◄────────────────────────────────────────────┐
        └─────┬────────┘                                             │
              │                                                      │
              ▼                                                      │
    ┌──────────────────────┐                                         │
    │   config.js          │   Loads env vars                        │
    └──────────────────────┘                                         │
              │                                                      │
              ▼                                                      │
    ┌──────────────────────┐                                         │
    │ signalingSocket.js   │◄────┐  Manages signaling WS             │
    └──────┬───────────────┘     │                                   │
           │                     │                                   │
           ▼                     │                                   │
    ┌──────────────────────┐     │                                   │
    │  mediaSocket.js      │◄────┘  Called after signaling success   │
    └──────┬───────────────┘                                         │
           ▼                                                         |
    ┌────────────────────────────┐                                   |
    │ mediaMessageHandler.js     │  Handles RTMS msg and media       |
    └────────────────────────────┘                                   |
                                                                     |
        ┌──────────────────────┐                                     |
        │ s2sZoomApiClient.js  │◄──────────── Optional API calls     |
        └──────────────────────┘                                     |
                                                                     |
        ┌──────────────────────┐                                     |
        │ frontendWss.js       │◄────────────── setup frontend WS   ─┘
        └──────────────────────┘                for Zoom App   


## Web Interface

- Visit `http://localhost:3000/` for the Zoom App context viewer. 
Note: This is meant to be viewed from Zoom Client. It is normal to encounter permission error if loaded from your local browser direclty.

### 🧠 How Zoom Apps Provide Context with `sdk.js`

In this sample, we have provided a simple implementation in `/views/index.ejs`

Zoom Apps run inside the Zoom desktop embedded as a web view. To securely access meeting and user context, Zoom provides a JavaScript SDK:

👉 [`https://appssdk.zoom.us/sdk.js`](https://appssdk.zoom.us/sdk.js)

#### 🔧 How It Works

1. **Zoom loads your app inside an web view**  
   Your Zoom App frontend (e.g. `/views/index.ejs`) is hosted on your server and embedded by Zoom into an web view.

2. **`sdk.js` enables communication with Zoom**  
   The sample `/views/index.ejs`) loads the SDK :
   ```html
   <script src="https://appssdk.zoom.us/sdk.js"></script>
   ```

3. **Initialize the SDK**
   ```js
   await zoomSdk.config({
     capabilities: [
       'getAppContext',
       'getUserContext',
       'getMeetingContext',
       'getMeetingUUID',
       'getSupportedJsApis'
     ],
     version: '0.16.0'
   });
   ```

4. **Retrieve Contextual Data**
   You can then call SDK methods to get live Zoom context:

   ```js
   const userContext = await zoomSdk.getUserContext();
   const meetingContext = await zoomSdk.getMeetingContext();
   const appContext = await zoomSdk.getAppContext();
   const meetingUUID = await zoomSdk.getMeetingUUID();
   ```

   These return info such as:
   - Display name, user ID
   - Meeting number, role
   - Zoom App instance details
   - Unique meeting UUID (used for matching RTMS sessions)

5. **Web socket connection**
  
   You can make a connection the websocket created by `frontendWss.js` by creating a websocket client in `views/index.ejs` and connecting to websocket server endpoint. This allows your frontend Zoom App to receive realtime streaming information.

### 🔒 Security Considerations

- All SDK access is scoped to the current Zoom client session.
- You **must** whitelist the SDK domain in your Zoom App config:
  ```
  https://appssdk.zoom.us/sdk.js
  ```

### 🧪 Demo Page

This project includes a Zoom App demo page hosted here:

```
http://localhost:3000/
```

Use this to:
- Display Zoom session info
- Test SDK availability
- Validate your App's Zoom SDK integration

---


## WebSocket


Frontend apps can connect to:
```
ws://localhost:3000/ws
```
to receive real-time transcript or chat events via `broadcastToFrontendClients()`.

## Notes

- This example focuses on processing RTMS events and saving data based on message types.
- Handshakes and keep-alive messages are handled automatically for both signaling and media connections.
- Ensure your Zoom App is configured to send the appropriate webhook events.
- RTMS must be enabled for your Zoom account and meeting.

## Security

- Keep the `.env` file secret and do not commit to version control.
- In production, run behind HTTPS and validate webhook signatures.


## How it Works

1. The server listens for RTMS webhook events from Zoom (`/webhook` endpoint).
2. On receiving a `meeting.rtms_started` event, it connects to Zoom's signaling server via WebSocket.
3. Upon successful handshake, it connects to the media WebSocket server.
4. The server listens for and processes incoming media messages in `mediaMessageHandler.js`:
   - **msg_type 14**: Audio
   - **msg_type 15**: Video
   - **msg_type 16**: Screen Share (Image/Video formats)
   - **msg_type 17**: Transcript
   - **msg_type 18**: Chat


## index.ejs (Zoom App Context Viewer)

The `views/index.ejs` file is a lightweight frontend page intended to be used within a Zoom App. It uses the Zoom App SDK to retrieve and display contextual information about the current Zoom session.

### Key Features:

- Loads and initializes the Zoom SDK
- Retrieves contextual information using the following capabilities:
  - `getSupportedJsApis`
  - `getRunningContext`
  - `getMeetingContext`
  - `getUserContext`
  - `getMeetingUUID`
  - `getAppContext`
- Displays this information in a formatted and readable way
- Includes a canvas area for optional visual output (placeholder)

### Usage:

This page is served at the root (`/`) of the server and can be accessed via:
```
http://localhost:3000/
```

You can also integrate it into your Zoom App via an iframe, as long as `https://appssdk.zoom.us/sdk.js` is properly whitelisted in your app's "Domain Allow List" on the Zoom App Marketplace.

## Notes

- This example focuses on processing RTMS events and saving data based on message types.
- Handshakes and keep-alive messages are handled automatically for both signaling and media connections.
- Ensure your Zoom App is configured to send the appropriate webhook events.
- RTMS must be enabled for your Zoom account and meeting.


## Security

- The `.env` file must be kept secret. Never commit it to version control.
- Consider using HTTPS in production and validating Zoom webhook signatures for enhanced security.
