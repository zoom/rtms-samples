# Zoom RTMS Media Receiver (Spring Boot)

This Spring Boot example demonstrates how to receive real-time audio, video, screen share, transcript, and chat data from a Zoom meeting using the RTMS (Real-Time Media Streaming) service.
The Spring server connects to Zoom's RTMS infrastructure via WebSocket, handles webhook events, and processes incoming media messages.

## Prerequisites

- Java 17 or higher
- Maven 3.6 or higher
- A Zoom account with RTMS enabled
- Zoom App credentials (Client ID and Client Secret)
- Zoom Secret Token for webhook validation

## Setup

1. Install dependencies and build:
```bash
mvn clean install
```

2. Configure environment variables by creating a `.env` file in the project root:
```properties
# Zoom Configuration
ZOOM_CLIENT_ID=your_client_id
ZOOM_CLIENT_SECRET=your_client_secret
ZOOM_SECRET_TOKEN=your_secret_token

# Server Configuration
SERVER_PORT=5050

# Application Configuration
APP_WEBHOOK_PATH=/webhook
APP_MODE=webhook
```

## Running the Example

1. Run the application:
```bash
mvn spring-boot:run
# or
java -jar target/vsdk-working-java-1.0.0.jar
```

2. Expose your local server using a tool like ngrok:
```bash
ngrok http 5050
```

3. Set your Zoom App's Event Notification URL to point to your ngrok endpoint, e.g.:
```
https://<your-ngrok-subdomain>.ngrok.io/webhook
```

4. Start a Zoom meeting and initiate RTMS streaming.

## Architecture

```
src/main/java/com/zoom/rtms/vsdkworkingjava/
├── VsdkWorkingJavaApplication.java          # Main Spring Boot application
├── config/
│   ├── ZoomConfig.java                      # Zoom configuration properties
│   └── AppConfig.java                       # Application configuration properties
├── controller/
│   └── WebhookController.java               # REST endpoint for webhook handling
├── model/
│   ├── WebhookEvent.java                    # Webhook payload model
│   ├── RtmsStatus.java                      # RTMS status codes enum
│   ├── RtmsStates.java                      # RTMS states and enums
│   └── RtmsMessages.java                    # RTMS protocol message DTOs
└── service/
    ├── RmsService.java                      # Core RTMS service with WebSocket clients
    └── RtmsConnection.java                  # Connection state management
```

## Flow Diagram

```
Zoom App/Webhook ──► WebhookController ──► RmsService
       │                       │                    │
       └── Validation Response ◄─┘                    │
                                                    │
                                                    ▼
                                           RTMS WebSocket Flow:
                                           1. Signaling Handshake
                                           2. Media URL Response
                                           3. Media Handshake
                                           4. Event Subscription
                                           5. Media Data Streaming
                                           6. Keep-alive messages
```

## WebSocket Connections

The application maintains two WebSocket connections per RTMS session:

### Signaling WebSocket
- Handles session management and control messages
- Exchanges handshake, keep-alive, and event messages
- Provides media server URLs

### Media WebSocket
- Receives actual media data (audio, video, transcript, chat)
- Handles binary data streams
- Processes keep-alive messages

## RTMS Protocol

The application implements the Zoom RTMS WebSocket protocol:

### Message Types (Signaling)
- `1`: SIGNALING_HANDSHAKE_REQ
- `2`: SIGNALING_HANDSHAKE_RESP
- `5`: EVENT_SUBSCRIPTION_REQ
- `6`: EVENT_MESSAGE
- `7`: READY_NOTIFICATION (sent after media handshake succeeds)
- `8`: STREAM_STATE_CHANGE
- `9`: SESSION_STATE_CHANGE
- `12`: KEEP_ALIVE_REQ
- `13`: KEEP_ALIVE_RESP

### Message Types (Media)
- `3`: DATA_HANDSHAKE_REQ
- `4`: DATA_HANDSHAKE_RESP
- `12-13`: Keep-alive messages
- `14`: Audio data
- `15`: Video data
- `16`: Screen share data
- `17`: Transcript data
- `18`: Chat data

## Configuration

### Environment Variables
- `ZOOM_CLIENT_ID`: Your Zoom app client ID
- `ZOOM_CLIENT_SECRET`: Your Zoom app client secret
- `ZOOM_SECRET_TOKEN`: Secret token for webhook validation
- `SERVER_PORT`: Server port (default: 5050)
- `APP_WEBHOOK_PATH`: Webhook endpoint path (default: /webhook)
- `APP_MODE`: Application mode (default: webhook)

## Security

- HMAC-SHA256 signatures for WebSocket authentication
- Webhook URL validation with encrypted tokens
- Connection state management and cleanup
- Keep environment variables secure and not committed to version control

## Logging

The application provides detailed logging for:
- WebSocket connection states
- RTMS session and stream states
- Media data reception
- Error conditions and troubleshooting

Set different log levels as needed:
```properties
logging.level.com.zoom=DEBUG
logging.level.org.springframework.web.socket=WARN
```

## Development

### Building
```bash
mvn clean compile
```

### Testing
```bash
mvn test
```

### Running in Development
```bash
mvn spring-boot:run -Dspring-boot.run.profiles=dev
```

## Notes

- This example focuses on RTMS event processing and data reception
- WebSocket connections automatically handle handshakes and keep-alive messages
- Media data is currently logged but can be extended to process/save binary data
- Ensure your Zoom App has RTMS enabled and proper webhook permissions
- RTMS requires Zoom account-level configuration

## Comparison with Node.js Version

This Spring Boot implementation provides:
- Type safety with Java records and enums
- Spring Boot ecosystem (auto-configuration, dependency injection)
- Structured logging with SLF4J
- WebSocket client implementation with OkHttp
- Spring MVC for REST endpoints
- Async processing with @Async annotations

Equivalent features from the Node.js version:
- Webhook handling with validation
- RTMS session start/stop
- Dual WebSocket connections (signaling + media)
- Event processing and logging
- Connection reconnection logic
- HMAC signature generation

## Docker

The project runs the Java Video SDK RTMS webhook and media receiver. Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f video-sdk/vsdk_working_java/Dockerfile -t rtms-video-sdk-vsdk_working_java .
docker run --rm --env-file video-sdk/vsdk_working_java/.env -p 3000:3000 rtms-video-sdk-vsdk_working_java
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.

## Webhook Delivery Authentication

Normal Zoom webhook deliveries are verified against the exact raw request body using
`x-zm-signature` and `x-zm-request-timestamp`. Configure `ZOOM_SECRET_TOKEN` with the
Marketplace app's webhook Secret Token. Requests with missing, invalid, or stale
signatures are rejected; the default replay window is 300 seconds and can be changed
with `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`.
