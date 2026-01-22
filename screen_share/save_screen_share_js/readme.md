# Zoom RTMS Save Screen Share (JavaScript)

This sample application demonstrates how to use the `RTMSManager` from the shared library to capture and save screen share (deskshare) frames from Zoom meetings to local storage.

## Project Overview

- Uses `RTMSManager` for simplified connection and event handling.
- Uses `WebhookManager` to handle Zoom RTMS webhooks.
- Detects and saves **JPEG**, **PNG**, and **H.264** formats.
- Organizes recordings by meeting ID.
- Implemented as an ES module (`"type": "module"`).

## Prerequisites

- Node.js v18 or higher.
- A Zoom App with RTMS permissions (Meetings and RTMS scopes).
- A tunneling service like Ngrok to expose your local server.

## Environment Variables

Create a `.env` file in this directory:

```env
ZOOM_CLIENT_ID=your_client_id
ZOOM_CLIENT_SECRET=your_client_secret
ZOOM_SECRET_TOKEN=your_webhook_secret_token
PORT=3000
WEBHOOK_PATH=/webhook
```

## How It Works

1. The application initializes `RTMSManager` with `mediaTypesFlag: 4` (sharescreen).
2. When a `sharescreen` event is emitted, the frame is passed to `handleShareData`.
3. Frames are saved to the `recordings/{meetingId}/` directory.
4. **Format Handling**:
   - **JPEG**: Saved as individual `.jpg` files. Frames smaller than 1000 bytes or within the first 3 frames are skipped to ensure quality.
   - **PNG**: Saved as individual `.png` files.
   - **H.264**: Appended to a user-specific `.h264` stream file.

## Sharescreen Payload Structure

The `sharescreen` event provides a payload with the following properties:

| Property | Description |
|----------|-------------|
| `buffer` | Raw image (JPEG/PNG) or video (H264) buffer. |
| `userId` | The ID of the user sharing their screen. |
| `userName` | The name of the user sharing their screen. |
| `timestamp` | The timestamp of the frame. |
| `meetingId` | The UUID of the Zoom meeting. |
| `streamId` | The internal RTMS stream ID. |
| `productType` | Either `"meeting"` or `"session"`. |

## Running the Application

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   node index.js
   ```

3. Start Ngrok (or similar) to expose port 3000:
   ```bash
   ngrok http 3000
   ```

4. Update your Zoom App's Event Notification URL to `https://your-ngrok-url/webhook`.
