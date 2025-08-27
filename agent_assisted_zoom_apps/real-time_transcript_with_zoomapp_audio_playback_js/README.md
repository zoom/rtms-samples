# Zoom RTMS Media Receiver with AI Assistant (Node.js)

This Node.js application demonstrates how to receive real-time audio, video, screen share, transcript, and chat data from a Zoom meeting using the RTMS (Real-Time Media Streaming) service, enhanced with AI-powered conversational capabilities and text-to-speech functionality.

The server connects to Zoom's RTMS infrastructure via WebSocket, handles webhook events, and provides a Zoom App frontend interface for real-time AI assistance during meetings.

## Features

- **Real-time Media Streaming**: Receive audio, video, screen share, transcript, and chat from Zoom meetings. Only transcript is being sent to LLM at the moment.
- **AI-Powered Conversations**: Integration with OpenRouter for LLM responses
- **Text-to-Speech**: Deepgram integration for audio synthesis and playback
- **Interactive Frontend**: "Zoom App Frontend" web interface with chat-like UI
- **Zoom App Integration**: Full Zoom SDK integration for contextual information
- **Real-time Audio Playback**: Browser-based audio playback of responses

## Prerequisites

- Node.js v18 or higher
- A Zoom account with RTMS enabled
- Zoom App credentials (Client ID and Client Secret)
- Zoom Secret Token for webhook validation
- Optional: Zoom Server to Server OAuth credentials for S2S API calls
- Mandatory: OpenRouter API key for AI chat functionality
- Mandatory: Deepgram API key for text-to-speech

## Dependencies

This project uses the following key dependencies:

- **express**: Web server framework
- **ws**: WebSocket server and client
- **dotenv**: Environment variable management
- **@deepgram/sdk**: Text-to-speech functionality
- **openai**: OpenRouter API integration for AI chat
- **uuid**: Unique identifier generation
- **node-fetch**: HTTP requests
- **ejs**: Template engine (for future use)

## Frontend Dependencies

The frontend is **self-contained** with no external CDN dependencies:
- **No external fonts**: Uses system font stack for optimal performance
- **No external libraries**: Only the required Zoom SDK for functionality
- **Faster loading**: No external requests except for Zoom SDK

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory with the following content:

### Required Environment Variables
```env
# Zoom App Credentials (Required)
ZOOM_CLIENT_ID=your_client_id
ZOOM_CLIENT_SECRET=your_client_secret
ZOOM_SECRET_TOKEN=your_secret_token

# Server Configuration
PORT=3000
WEBHOOK_PATH=/webhook

# Operation Mode (webhook or websocket)
MODE=webhook

# Frontend WebSocket URL (for production deployment)
WS_URL=wss://yoururl.ngrok.com/ws
```

### Optional Environment Variables
```env
# For WebSocket Mode (alternative to webhooks)
zoomWSURLForEvents=wss://ws.zoom.us/ws?subscriptionId=your_subscription_id

# Zoom Server-to-Server OAuth (optional)
ZOOM_S2S_CLIENT_ID=your_s2s_client_id
ZOOM_S2S_CLIENT_SECRET=your_s2s_client_secret
ZOOM_ACCOUNT_ID=your_account_id

# AI Services (mandatory)
OPENROUTER_API_KEY=sk-or-v1-your_openrouter_key
DEEPGRAM_API_KEY=your_deepgram_api_key
```

Refer to `.env.example` for a complete reference.

## Operation Modes

### Webhook Mode (Default)
```env
MODE=webhook
```
- Receives Zoom events via HTTP webhooks
- Requires public endpoint (use ngrok for development)
- More reliable for production deployments

### WebSocket Mode
```env
MODE=websocket
zoomWSURLForEvents=wss://ws.zoom.us/ws?subscriptionId=your_subscription_id
```
- Receives Zoom events via WebSocket subscription
- Requires Zoom WebSocket subscription setup
- Real-time event delivery

## Running the Application

1. Start the server:
```bash
node index.js
```

2. For webhook mode, expose your local server using ngrok:
```bash
ngrok http 3000
```

3. Configure your Zoom App's Event Notification URL:
```
https://<your-ngrok-subdomain>.ngrok.io/webhook
```

4. Start a Zoom meeting and initiate RTMS streaming.

## Project Structure

```
.
├── index.js                  # Main entry point, handles webhooks/WebSocket, RTMS lifecycle
├── config.js                 # Environment configuration loader
├── signalingSocket.js        # RTMS signaling WebSocket handler
├── mediaSocket.js            # RTMS media WebSocket handler
├── mediaMessageHandler.js    # Processes RTMS media messages (audio, video, etc.)
├── frontendWss.js            # WebSocket server for frontend clients
├── deepgramService.js        # Text-to-speech service using Deepgram
├── chatWithOpenrouter.js     # AI chat integration via OpenRouter
├── s2sZoomApiClient.js       # Zoom Server-to-Server API client
├── public/
│   ├── index.html            # Zoom App Frontend - Main interface (self-contained)
│   └── audio-client.js       # Audio WebSocket client for real-time communication
├── utils/
│   ├── rtmsEventLookup.js    # RTMS event type definitions
│   └── signature.js          # Webhook signature validation
├── logs/                     # Application logs directory
├── recordings/               # Media files storage directory
├── .env                      # Environment variables (create from .env.example)
└── package.json
```

## Architecture Overview

```
┌─────────────────┐    ┌───────────────────┐    ┌─────────────────┐
│   Zoom Meeting  │──> │   RTMS Events     │───>│   index.js      │
│                 │    │(Webhook/WebSocket)│    │                 │
└─────────────────┘    └───────────────────┘    └────────┬────────┘
                                                         │
                       ┌─────────────────────────────────┼─────────────────┐
                       │                                 ▼                 │
                       │        ┌──────────────────────────────────────┐   │
                       │        │         config.js                    │   │
                       │        └──────────────────────────────────────┘   │
                       │                                 │                 │
                       │                                 ▼                 │
                       │        ┌──────────────────────────────────────┐   │
                       │        │      signalingSocket.js              │   │
                       │        └─────────────┬────────────────────────┘   │
                       │                      │                            │
                       │                      ▼                            │
                       │        ┌──────────────────────────────────────┐   │
                       │        │       mediaSocket.js                 │   │
                       │        └─────────────┬────────────────────────┘   │
                       │                      │                            │
                       │                      ▼                            │
                       │        ┌──────────────────────────────────────┐   │
                       │        │    mediaMessageHandler.js            │   │
                       │        └─────────────┬────────────────────────┘   │
                       │                      │                            │
                       │                      ▼                            │
                       │        ┌──────────────────────────────────────┐   │
                       │        │      frontendWss.js                  │   │
                       │        └─────────────┬────────────────────────┘   │
                       │                      │                            │
                       │                      ▼                            │
                       │        ┌──────────────────────────────────────┐   │
                       │        │     Zoom App Frontend                │   │
                       │        │    (public/index.html)               │   │
                       │        └──────────────────────────────────────┘   │
                       └───────────────────────────────────────────────────┘

┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  OpenRouter AI  │<───│chatWithOpenrouter│<───│  User Messages  │
│                 │    │      .js         │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘

┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Deepgram TTS  │<───│  deepgramService │<───│  AI Responses   │
│                 │    │      .js         │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## Zoom App Frontend Interface

The application provides a modern web Zoom App Frontend interface accessible at:
```
http://localhost:3000/
```

### Key Features:

- **Real-time Chat Interface**: Chat-like UI 
- **Zoom SDK Integration**: Full access to meeting context and user information
- **Audio Playback**: Real-time playback of AI-generated speech responses

### Zoom SDK Capabilities:

The interface uses the Zoom App SDK with the following capabilities:
- `getSupportedJsApis` - Check available SDK functions
- `getRunningContext` - Get current Zoom context
- `getMeetingContext` - Access meeting information
- `getUserContext` - Get user details
- `getMeetingUUID` - Retrieve unique meeting identifier
- `getAppContext` - Get app-specific context
- `startRTMS`/`stopRTMS` - Control RTMS streaming
- `onRTMSStatusChange` - Monitor RTMS status

## WebSocket Communication

### Frontend WebSocket (Browser ↔ Server)
```
ws://localhost:3000/ws
```

#### Message Types:

| Type | Direction | Purpose |
|------|-----------|---------|
| `client_ready` | Client → Server | Initialize connection with meeting context |
| `ready` | Server → Client | Confirm server is ready |
| `text` | Bidirectional | Text messages and AI responses |
| `html` | Server → Client | Rich content (notes, tables) |
| `audio` | Bidirectional | Base64-encoded PCM audio data |
| `end` | Client → Server | End audio recording session |

### RTMS WebSocket (Server ↔ Zoom)
Handles real-time media streaming with message types:
- **msg_type 14**: Audio data
- **msg_type 15**: Video data  
- **msg_type 16**: Screen share
- **msg_type 17**: Transcript data
- **msg_type 18**: Chat messages

## AI Integration

### OpenRouter Chat
- Supports multiple AI models (Claude, Llama, etc.)
- Contextual conversation synthesis
- Configurable response length and style
- Error handling and fallback responses

### Deepgram Text-to-Speech
- High-quality voice synthesis
- Multiple voice models available
- Real-time audio streaming
- Base64 encoding for web delivery

## Security Considerations

### Production Deployment
- Use HTTPS for all endpoints
- Validate Zoom webhook signatures
- Implement proper CORS policies
- Secure API keys in environment variables

### Content Security Policy
```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://appssdk.zoom.us; style-src 'self' 'unsafe-inline'; font-src 'self';" always;
```

### WebSocket Proxy (Nginx)
```nginx
location /ws {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

## Zoom Marketplace Configuration

For Zoom App deployment:

### Required Settings:
- **Domain Allowlist**: Include required external domains:
  - `appssdk.zoom.us` (Zoom SDK - required for functionality)


### SDK Capabilities:
Enable all required Zoom SDK APIs in your app configuration.

### Event Subscriptions:
- `meeting.rtms_started`
- `meeting.rtms_stopped`

## Development

### Local Development
1. Use ngrok for webhook testing
2. Set up environment variables
3. Configure Zoom App with ngrok URL
4. Test with actual Zoom meetings

### Debugging
- Check browser console for frontend errors
- Monitor server logs for WebSocket connections
- Verify RTMS event delivery
- Test AI service integrations separately

## Troubleshooting

### Common Issues:

1. **WebSocket Connection Failed**
   - Check firewall settings
   - Verify ngrok tunnel is active
   - Confirm WebSocket URL in frontend

2. **RTMS Not Starting**
   - Ensure RTMS is enabled for your Zoom account
   - Verify webhook/WebSocket event delivery
   - Check Zoom App permissions

3. **AI Services Not Working**
   - Verify API keys are correct
   - Check service quotas and billing
   - Monitor API response errors

4. **Audio Playback Issues**
   - Ensure browser supports Web Audio API
   - Check CORS headers for audio data
   - Verify Deepgram audio format

## License

This project is provided as a sample implementation for educational and development purposes.
