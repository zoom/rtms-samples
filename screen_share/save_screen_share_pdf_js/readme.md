# Zoom RTMS Intelligent Screen Share PDF Generator (JavaScript)

This sample application demonstrates how to use the `RTMSManager` from the shared library to capture screen share (deskshare) frames, filter out duplicates, and generate a PDF report of unique content.

## Project Overview

- Uses `RTMSManager` for simplified connection and event handling.
- Uses `WebhookManager` to handle Zoom RTMS webhooks.
- Performs **duplicate detection** using `sharp` and `pixelmatch`.
- Saves only unique frames (>1% pixel difference) to `recordings/{meetingId}/processed/jpg/`.
- Automatically generates a **PDF report** and `frames.txt` mapping when the meeting ends.
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
2. On every `sharescreen` event, the frame is compared against the previously accepted frame.
3. **Uniqueness Check**:
   - Uses `sharp` to convert JPEG to raw RGBA buffer.
   - Uses `pixelmatch` to count different pixels.
   - If more than 1% of pixels are different, the frame is considered unique and saved.
4. When the meeting ends (`meeting.rtms_stopped`), the application:
   - Compiles all unique frames into a single PDF (`approved.pdf`).
   - Creates a mapping of page numbers to timestamps in `frames.txt`.
   - Saves both to `recordings/{meetingId}/processed/`.

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
