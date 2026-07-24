# Print RTMS Chat Messages

This Node.js sample receives in-meeting chat through Zoom Realtime Media
Streams (RTMS) and prints each message with its sender and metadata. It uses
the shared JavaScript `RTMSManager` and requests only chat media.

## What It Prints

For each RTMS chat message, the sample prints:

- Message text and sender
- Direct-message receiver, when present
- Chat session type and session ID
- Operation type, including new, edited, deleted, and reaction changes
- Message and parent-message IDs
- Attached and deleted-file metadata
- Meeting, stream, product, and timestamp metadata

Set `PRINT_FULL_CHAT_PAYLOAD=true` to also print the complete event emitted by
`RTMSManager`.

## Marketplace App Configuration

Create a Zoom **General App** in the Zoom App Marketplace and configure:

1. Enable RTMS for the app.
2. Add the `meeting:read:meeting_chat` scope.
3. Subscribe to the `meeting.rtms_started` and `meeting.rtms_stopped` events.
4. Set the event notification endpoint to your public HTTPS webhook URL, for
   example `https://example.com/webhook`.
5. Copy the app's Client ID, Client Secret, and webhook Secret Token into
   `.env`.

The account and meeting must allow in-meeting chat. The app only receives chat
destinations that its RTMS permissions allow.

## Install

```bash
cd chat/print_chat_messages_js
npm install
cp .env.example .env
```

Edit `.env`:

```dotenv
ZOOM_CLIENT_ID=your_zoom_client_id
ZOOM_CLIENT_SECRET=your_zoom_client_secret
ZOOM_SECRET_TOKEN=your_zoom_webhook_secret_token

PORT=3000
WEBHOOK_PATH=/webhook
MEDIA_SOCKET_CONNECTION_MODE=split
RTMS_LOG_LEVEL=info
PRINT_FULL_CHAT_PAYLOAD=false
```

Expose `WEBHOOK_PATH` through a public HTTPS URL and use that complete URL in
the Marketplace event subscription.

## Run

```bash
npm start
```

The health endpoint is available at:

```text
GET /health
```

After RTMS starts for a meeting, sending a chat message produces output similar
to:

```text
[Chat] NEW John Smith (16778240): Hello everyone
[Chat] Metadata: {
  session: 'EVERYONE',
  sessionId: null,
  messageId: '...',
  parentMessageId: null,
  timestamp: 1771635627032,
  attachments: [],
  deletedFileIds: [],
  meetingId: '...',
  streamId: '...',
  productType: 'meeting'
}
```

## RTMS Chat Values

The media connection is established with `mediaTypes: 16`, which is the RTMS
chat media flag. Incoming chat media uses message type `18`.

Chat session types:

| Value | Meaning |
| --- | --- |
| `1` | Everyone |
| `2` | Individual |
| `3` | Private chat group |
| `4` | Hosts and panelists |
| `5` | Individual, copied to hosts and panelists |

Operation types:

| Value | Meaning |
| --- | --- |
| `1` | New message |
| `2` | Delete message |
| `3` | Update message |
| `4` | Add emoji reaction |
| `5` | Remove emoji reaction |

## Privacy

Chat messages can contain personal or confidential information. This sample
prints them to standard output. Restrict access to process logs and avoid
enabling full-payload logging in environments where chat content must not be
retained.
