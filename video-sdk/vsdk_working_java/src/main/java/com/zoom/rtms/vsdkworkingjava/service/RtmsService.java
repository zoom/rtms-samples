package com.zoom.rtms.vsdkworkingjava.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zoom.rtms.vsdkworkingjava.config.ZoomConfig;
import com.zoom.rtms.vsdkworkingjava.model.RtmsMessages;
import com.zoom.rtms.vsdkworkingjava.model.RtmsStates;
import com.zoom.rtms.vsdkworkingjava.model.WebhookEvent;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import jakarta.annotation.PreDestroy;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

@Service
@RequiredArgsConstructor
public class RtmsService {

    private static final Logger log = LoggerFactory.getLogger(RtmsService.class);

    private final ObjectMapper objectMapper;
    private final ZoomConfig zoomConfig;
    private final Map<String, RtmsConnection> activeConnections = new ConcurrentHashMap<>();
    private final Set<String> signalingHandshakeLocks = Collections.newSetFromMap(new ConcurrentHashMap<>());
    private final HttpClient httpClient = HttpClient.newHttpClient();

    @PreDestroy
    public void shutdown() {
        log.info("Application shutdown requested; closing {} RTMS connection(s)", activeConnections.size());
        activeConnections.values().forEach(connection -> {
            connection.setShouldReconnect(false);
            closeSocket(connection.getSignaling() == null ? null : connection.getSignaling().getSocket());
            closeSocket(connection.getMedia() == null ? null : connection.getMedia().getSocket());
        });
        activeConnections.clear();
        signalingHandshakeLocks.clear();
    }

    private void closeSocket(WebSocket socket) {
        if (socket == null) return;
        try {
            socket.sendClose(WebSocket.NORMAL_CLOSURE, "Server shutdown").get(5, TimeUnit.SECONDS);
        } catch (Exception error) {
            log.warn("WebSocket shutdown failed: {}", error.getMessage());
            socket.abort();
        }
    }

    public void handleWebhookEvent(WebhookEvent webhookEvent) {
        log.info("Received webhook event: {}", webhookEvent.event());
        log.debug("Webhook payload: {}", webhookEvent.payload());

        if ("endpoint.url_validation".equals(webhookEvent.event())) {
            handleUrlValidation(webhookEvent.payload());
        } else if ("session.rtms_started".equals(webhookEvent.event())) {
            handleRtmsStarted(webhookEvent.payload());
        } else if ("session.rtms_stopped".equals(webhookEvent.event())) {
            handleRtmsStopped(webhookEvent.payload());
        }
    }

    private void handleUrlValidation(Map<String, Object> payload) {
        String plainToken = (String) payload.get("plainToken");
        if (plainToken != null) {
            String encryptedToken = generateValidationToken(plainToken);
            log.info("Generated encrypted token for validation");
            // Return via controller method
        }
    }

    private void handleRtmsStarted(Map<String, Object> payload) {
        String sessionId = (String) payload.get("session_id");
        String rtmsStreamId = (String) payload.get("rtms_stream_id");
        String serverUrls = (String) payload.get("server_urls");

        if (rtmsStreamId == null || rtmsStreamId.isEmpty()) {
            log.warn("Missing rtms_stream_id in session.rtms_started payload, ignoring event");
            return;
        }

        if (!signalingHandshakeLocks.add(rtmsStreamId)) {
            log.warn("Duplicate signaling handshake blocked for stream {}", rtmsStreamId);
            return;
        }

        log.info("Starting RTMS for session {} with stream {}", sessionId, rtmsStreamId);

        // Check if connection already exists and is active
        RtmsConnection existingConnection = activeConnections.get(sessionId);
        if (existingConnection != null) {
            log.info("RTMS session {} already exists, checking if active", sessionId);

            // Check if WebSocket connections are still active (OkHttp doesn't have
            // isOpen(), check if not null)
            boolean signalingActive = existingConnection.getSignaling().getSocket() != null;
            boolean mediaActive = existingConnection.getMedia().getSocket() != null;

            if (signalingActive || mediaActive) {
                log.warn("RTMS session {} has active connections, skipping new connection attempt", sessionId);
                return;
            } else {
                log.info("RTMS session {} exists but connections are inactive, cleaning up", sessionId);
                cleanupConnection(existingConnection);
            }
        }

        RtmsConnection.SignalingConnection signaling = RtmsConnection.SignalingConnection.builder()
                .state(RtmsConnection.SignalingConnection.SignalingState.CONNECTING)
                .lastKeepAlive(0)
                .build();

        RtmsConnection.MediaConnection media = RtmsConnection.MediaConnection.builder()
                .state(RtmsConnection.MediaConnection.MediaState.IDLE)
                .lastKeepAlive(0)
                .build();

        RtmsConnection connection = RtmsConnection.builder()
                .sessionId(sessionId)
                .streamId(rtmsStreamId)
                .serverUrls(serverUrls)
                .shouldReconnect(true)
                .signaling(signaling)
                .media(media)
                .build();

        activeConnections.put(sessionId, connection);

        connectToSignalingWebSocket(connection);
    }

    private void handleRtmsStopped(Map<String, Object> payload) {
        String sessionId = (String) payload.get("session_id");
        String rtmsStreamId = (String) payload.get("rtms_stream_id");
        log.info("Stopping RTMS for session {}", sessionId);
        if (rtmsStreamId != null) {
            signalingHandshakeLocks.remove(rtmsStreamId);
        }

        RtmsConnection connection = activeConnections.get(sessionId);
        if (connection != null) {
            connection.setShouldReconnect(false);
            cleanupConnection(connection);
            activeConnections.remove(sessionId);
        }
    }

    @Async
    public void connectToSignalingWebSocket(RtmsConnection conn) {
        log.info("[Signaling] Starting connection function for video session {}", conn.getSessionId());
        log.info("[Signaling] Stream ID: {}, Server URL: {}", conn.getStreamId(), conn.getServerUrls());
        log.info("[Signaling] Connecting for video session {}", conn.getSessionId());

        try {
            if (conn.getServerUrls() == null || !conn.getServerUrls().startsWith("ws")) {
                log.error("[Signaling] ❌ Invalid WebSocket URL: {}", conn.getServerUrls());
                log.error("[Signaling] URL validation failed - URL is null/undefined or doesn't start with ws/wss");

                if (activeConnections.containsKey(conn.getSessionId())) {
                    log.error("[Signaling] sessionID found in activeConnections map");
                    RtmsConnection activeConn = activeConnections.get(conn.getSessionId());
                    activeConn.setShouldReconnect(false);
                    log.error("[Signaling] sessionID found in activeConnections map. disabling reconnection");
                } else {
                    log.error("[Signaling] sessionID not found in activeConnections map");
                }
                return;
            }

            log.info("[Signaling] Creating Java WebSocket instance for {}", conn.getServerUrls());

            SignalingWebSocketListener listener = new SignalingWebSocketListener(conn);
            CompletableFuture<WebSocket> wsFuture = httpClient.newWebSocketBuilder()
                    .buildAsync(URI.create(conn.getServerUrls()), listener);

            WebSocket webSocket = wsFuture.join();
            conn.getSignaling().setSocket(webSocket);
            conn.getSignaling().setState(RtmsConnection.SignalingConnection.SignalingState.CONNECTING);
            log.info("[Signaling] Connection state set to 'connecting' for {}", conn.getSessionId());
            log.info("[Signaling] Java WebSocket instance created successfully");

        } catch (Exception e) {
            log.error("[Signaling] ❌ Failed to create Java WebSocket instance: {}", e.getMessage());
        }
    }

    @Async
    public void connectToMediaWebSocket(RtmsConnection conn, String mediaUrl, String sessionID, String streamId,
            WebSocket signalingSocket, Map<String, RtmsConnection> activeConnections) {
        log.info("[Media] Connecting for video session {}", conn.getSessionId());

        try {

            MediaWebSocketListener listener = new MediaWebSocketListener(conn, mediaUrl);
            CompletableFuture<WebSocket> wsFuture = httpClient.newWebSocketBuilder()
                    .buildAsync(URI.create(mediaUrl), listener);

            WebSocket webSocket = wsFuture.join();
            conn.getMedia().setSocket(webSocket);
            conn.getMedia().setState(RtmsConnection.MediaConnection.MediaState.CONNECTING);
            log.info("[Media] WebSocket instance created successfully");

        } catch (Exception e) {
            log.error("[Media] ❌ Failed to create Java WebSocket instance: {}", e.getMessage());
        }
    }

    // Legacy method for backward compatibility
    @Async
    public void connectToMediaWebSocket(RtmsConnection conn, String mediaUrl) {
        connectToMediaWebSocket(conn, mediaUrl, conn.getSessionId(), conn.getStreamId(), null, activeConnections);
    }

    private String generateSignature(String sessionId, String streamId) {
        String clientId = zoomConfig.getClientId();
        String clientSecret = zoomConfig.getClientSecret();
        String message = clientId + "," + sessionId + "," + streamId;

        log.info("Generating RTMS signature:");
        log.info("  Client ID: {}", clientId);
        log.info("  Client Secret: {}", clientSecret != null ? "[LOADED]" : "[NULL]");
        log.info("  Message: {}", message);

        // Generate control signature for comparison (xxxx,yyyy) - doesn't affect actual
        // operation
        String controlMessage = clientId + ",cYEmfiTcQseHP1QjGUxNqQ==,ef7c8effe243433db7c26faa8745f709";
        String controlSignature = hmacSha256hex(controlMessage, clientSecret);
        log.info("🔍 CONTROL SIGNATURE (xxxx,yyyy): {}", controlSignature);

        // Node.js uses hex output, Java was using Base64 - fix to match Node.js
        return hmacSha256hex(message, clientSecret);
    }

    private String generateValidationToken(String plainToken) {
        log.info("Generating webhook validation token:");
        log.info("  Secret Token: {}", zoomConfig.getSecretToken() != null ? "[LOADED]" : "[NULL]");
        log.info("  Plain Token: {}", plainToken);

        String signature = hmacSha256(plainToken, zoomConfig.getSecretToken());
        log.info("  Generated signature: {}", signature);
        return signature;
    }

    private String hmacSha256(String message, String secret) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            SecretKeySpec secretKey = new SecretKeySpec(secret.getBytes(), "HmacSHA256");
            mac.init(secretKey);
            byte[] hash = mac.doFinal(message.getBytes());
            return Base64.getEncoder().encodeToString(hash);
        } catch (Exception e) {
            throw new RuntimeException("Failed to generate HMAC", e);
        }
    }

    private String hmacSha256hex(String message, String secret) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            SecretKeySpec secretKey = new SecretKeySpec(secret.getBytes(), "HmacSHA256");
            mac.init(secretKey);
            byte[] hash = mac.doFinal(message.getBytes());

            // Convert to hex string (matches Node.js .digest('hex'))
            StringBuilder hexString = new StringBuilder();
            for (byte b : hash) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1)
                    hexString.append('0');
                hexString.append(hex);
            }
            return hexString.toString();
        } catch (Exception e) {
            throw new RuntimeException("Failed to generate HMAC hex", e);
        }
    }

    private void cleanupConnection(RtmsConnection conn) {
        log.debug("Cleaning up connection for session: {}", conn.getSessionId());

        // Close signaling connection
        if (conn.getSignaling().getSocket() != null) {
            conn.getSignaling().getSocket().sendClose(WebSocket.NORMAL_CLOSURE, "Closing session");
        }

        // Close media connection
        if (conn.getMedia().getSocket() != null) {
            conn.getMedia().getSocket().sendClose(WebSocket.NORMAL_CLOSURE, "Closing session");
        }

        conn.getSignaling().setState(RtmsConnection.SignalingConnection.SignalingState.DISCONNECTED);
        conn.getMedia().setState(RtmsConnection.MediaConnection.MediaState.CLOSED);
    }

    private void processSignalingMessage(RtmsConnection conn, String message) {
        // log.info("[Signaling] Received message for session {}", conn.getSessionId());
        try {
            JsonNode msg = objectMapper.readTree(message);
            int msgType = msg.get("msg_type").asInt();
            // log.info("[Signaling] Parsed message type: {} for session {}", msgType,
            // conn.getSessionId());
            log.debug("[Signaling] Full message: {}", message);

            switch (msgType) {
                case 2 -> handleSignalingHandshakeResponse(conn, msg);
                case 6 -> handleEventMessage(conn, msg);
                case 8 -> handleStreamStateChange(conn, msg);
                case 9 -> handleSessionStateChange(conn, msg);
                case 12 -> handleSignalingKeepAlive(conn, msg);
                default ->
                    log.warn("[Signaling] Unhandled message type: {} for session {}", msgType, conn.getSessionId());
            }

        } catch (Exception e) {
            log.error("[Signaling] Failed to process message for session {}: {}", conn.getSessionId(), e.getMessage());
            log.debug("[Signaling] Raw message content: {}", message);
        }
    }

    private void processMediaMessage(RtmsConnection conn, String message) {
        // log.info("[Media] Received message for session {}", conn.getSessionId());
        try {
            JsonNode msg = objectMapper.readTree(message);
            int msgType = msg.get("msg_type").asInt();
            // log.info("[Media] Parsed message type {} for session {}", msgType,
            // conn.getSessionId());
            log.debug("[Media] Full message: {}", message);

            switch (msgType) {
                case 4 -> handleMediaHandshakeResponse(conn, msg);
                case 12 -> handleMediaKeepAlive(conn, msg);
                case 14 -> handleAudioData(conn, msg);
                case 15 -> handleVideoData(conn, msg);
                case 16 -> handleScreenShareData(conn, msg);
                case 17 -> handleTranscriptData(conn, msg);
                case 18 -> handleChatData(conn, msg);
                default -> log.warn("[Media] Unhandled message type: {} for session {}", msgType, conn.getSessionId());
            }

        } catch (Exception e) {
            log.error("[Media] Failed to process message for session {}: {}", conn.getSessionId(), e.getMessage());
            log.debug("[Media] Raw message content: {}", message);
        }
    }

    private void handleSignalingHandshakeResponse(RtmsConnection conn, JsonNode msg) {
        signalingHandshakeLocks.remove(conn.getStreamId());
        log.info("[Signaling] Processing handshake response (case 2) for {}", conn.getSessionId());
        log.info("[Signaling] Handshake response: {}", msg.toString());

        int statusCode = msg.get("status_code").asInt();
        if (statusCode == 0) {
            log.info("[Signaling] Handshake OK. Status code: {} for {}", statusCode, conn.getSessionId());

            // Combined media handshake should use the dedicated unified endpoint.
            String mediaUrl = msg.path("media_server").path("server_urls").path("all").asText();
            log.info("[Signaling] Media URL extracted: {} for {}", mediaUrl, conn.getSessionId());

            if (mediaUrl.isEmpty()) {
                log.error("[Signaling] No unified media URL (server_urls.all) received in handshake response for {}", conn.getSessionId());
                return;
            }

            conn.getSignaling().setState(RtmsConnection.SignalingConnection.SignalingState.READY);
            log.info("[Signaling] Connection state updated to 'ready' for {}", conn.getSessionId());

            log.info("[Signaling] Initiating media WebSocket connection for {}", conn.getSessionId());
            connectToMediaWebSocket(conn, mediaUrl, conn.getSessionId(), conn.getStreamId(),
                    conn.getSignaling().getSocket(), activeConnections);

            subscribeToEvents(conn);

        } else {
            log.warn("[Signaling] Handshake failed: status_code = {} for {}", statusCode, conn.getSessionId());
            // Log additional error information if present
            logRtmsStatusCode(statusCode);
            if (msg.has("reason")) {
                int reason = msg.get("reason").asInt();
                log.error("[Signaling] Stop reason: {} for {}", RtmsStates.StopReason.getStopReasonMessage(reason),
                        conn.getSessionId());
                logRtmsStopReason(reason);
            }
        }
    }

    private void handleEventMessage(RtmsConnection conn, JsonNode msg) {
        if (msg.has("event")) {
            JsonNode eventNode = msg.get("event");
            int eventType = eventNode.get("event_type").asInt();

            switch (eventType) {
                case 1 -> log.info("[Event] FIRST_PACKET_TIMESTAMP first media packet at {}",
                        eventNode.get("timestamp").asLong());
                case 2 -> processActiveSpeakerChange(eventNode);
                case 3 -> processParticipantJoin(eventNode);
                case 4 -> processParticipantLeave(eventNode);
                case 10 -> log.info("[Event] CHAT_GROUP_CREATE {}", eventNode);
                case 11 -> log.info("[Event] CHAT_GROUP_DELETE {}", eventNode);
                case 12 -> log.info("[Event] CHAT_GROUP_MEMBERS_ADD {}", eventNode);
                case 13 -> log.info("[Event] CHAT_GROUP_MEMBERS_DELETE {}", eventNode);
                case 14 -> log.info("[Event] CHAT_GROUP_MEMBER_STATUS_UPDATE {}", eventNode);
                default -> log.warn("Unknown event type: {}", eventType);
            }
        }
    }

    private void processActiveSpeakerChange(JsonNode eventNode) {
        if (eventNode.has("user_name") && eventNode.has("user_id")) {
            log.info("[Event] ACTIVE_SPEAKER_CHANGE {} ({}) is now speaking",
                    eventNode.get("user_name").asText(), eventNode.get("user_id").asText());
        }
    }

    private void processParticipantJoin(JsonNode eventNode) {
        if (eventNode.has("participants") && eventNode.get("participants").isArray()) {
            for (JsonNode participant : eventNode.get("participants")) {
                if (participant.has("user_name") && participant.has("user_id")) {
                    log.info("[Event] PARTICIPANT_JOIN {} ({}) joined",
                            participant.get("user_name").asText(), participant.get("user_id").asText());
                }
            }
        }
    }

    private void processParticipantLeave(JsonNode eventNode) {
        if (eventNode.has("participants") && eventNode.get("participants").isArray()) {
            for (JsonNode participant : eventNode.get("participants")) {
                if (participant.has("user_name") && participant.has("user_id")) {
                    log.info("[Event] PARTICIPANT_LEAVE {} ({}) left",
                            participant.get("user_name").asText(), participant.get("user_id").asText());
                }
            }
        }
    }

    private void handleStreamStateChange(RtmsConnection conn, JsonNode msg) {
        if (msg.has("state")) {
            int state = msg.get("state").asInt();
            log.info("{}", RtmsStates.StreamState.getStateMessage(state));
        }
        if (msg.has("reason")) {
            int reason = msg.get("reason").asInt();
            log.info("{}", RtmsStates.StopReason.getStopReasonMessage(reason));

            if (reason == 6 && msg.get("state").asInt() == 4) {
                log.info("Meeting ended, cleaning up connections");
                cleanupConnection(conn);
                activeConnections.remove(conn.getSessionId());
            }
        }
    }

    private void handleSessionStateChange(RtmsConnection conn, JsonNode msg) {
        if (msg.has("state")) {
            int state = msg.get("state").asInt();
            log.info("{}", RtmsStates.SessionState.getStateMessage(state));
            logRtmsSessionState(state);
        }
        if (msg.has("stop_reason")) {
            int reason = msg.get("stop_reason").asInt();
            log.info("{}", RtmsStates.StopReason.getStopReasonMessage(reason));
            logRtmsStopReason(reason);
        }
    }

    private void handleSignalingKeepAlive(RtmsConnection conn, JsonNode msg) {
        conn.getSignaling().setLastKeepAlive(System.currentTimeMillis());
        long timestamp = msg.get("timestamp").asLong();
        log.info("[Signaling] Processing keep-alive request (case 12) for {}", conn.getSessionId());
        log.info("[Signaling] Keep-alive timestamp received: {}", timestamp);
        log.info("[Signaling] Updated last keep-alive time for {}", conn.getSessionId());

        try {
            String response = objectMapper.writeValueAsString(
                    new RtmsMessages.KeepAliveResponse(13, timestamp));
            log.info("[Signaling] 📤 Sending keep-alive response toserver: {}", response);
            log.info("[Signaling] Keep-alive response payload: {}", response);

            // Double-check: using signaling WebSocket for signaling keep-alive
            if (conn.getSignaling().getSocket() != null) {
                conn.getSignaling().getSocket().sendText(response, true);
                log.info("[Signaling] ✅ Keep-alive response sent successfully via signaling WebSocket");
            } else {
                log.error("[Signaling] ❌ ERROR: No signaling WebSocket available to send keep-alive response!");
            }

        } catch (Exception e) {
            log.error("[Signaling] ❌ Failed to send keep-alive response: {}", e.getMessage());
        }
    }

    private void handleMediaHandshakeResponse(RtmsConnection conn, JsonNode msg) {
        log.info("[Media] Processing handshake response (case 4) for {}", conn.getSessionId());
        log.info("[Media] Media handshake response: {}", msg.toString());

        int statusCode = msg.get("status_code").asInt();
        if (statusCode == 0) {
            log.info("[Media] Handshake OK. Status code: {} for {}", statusCode, conn.getSessionId());
            try {
                RtmsMessages.ReadyNotification readyNotif = new RtmsMessages.ReadyNotification(7, conn.getStreamId());
                String readyMsg = objectMapper.writeValueAsString(readyNotif);
                log.info("[Media] Sending ready notification via SIGNALING socket for {}", conn.getSessionId());
                log.info("[Media] Ready message payload: {}", readyMsg);

                // CRITICAL FIX: Send via signaling socket, not media socket
                // This matches the JavaScript implementation and RTMS protocol requirements
                if (conn.getSignaling().getSocket() != null) {
                    conn.getSignaling().getSocket().sendText(readyMsg, true);
                    log.info("[Media] ✅ Ready notification sent successfully via signaling WebSocket");
                } else {
                    log.error("[Media] ❌ ERROR: No signaling WebSocket available to send ready notification!");
                }

                conn.getMedia().setState(RtmsConnection.MediaConnection.MediaState.STREAMING);
                log.info("[Media] Connection state updated to 'streaming' for {}", conn.getSessionId());
            } catch (Exception e) {
                log.error("[Media] Failed to send ready notification for {}: {}", conn.getSessionId(), e.getMessage());
            }
        } else {
            log.warn("[Media] Media handshake failed with status: {} for {}", statusCode, conn.getSessionId());
        }
    }

    private void handleMediaKeepAlive(RtmsConnection conn, JsonNode msg) {
        conn.getMedia().setLastKeepAlive(System.currentTimeMillis());
        long timestamp = msg.get("timestamp").asLong();
        log.info("[Media] Processing keep-alive request (case 12) for {}", conn.getSessionId());
        log.info("[Media] Keep-alive timestamp received: {}", timestamp);

        try {
            String response = objectMapper.writeValueAsString(
                    new RtmsMessages.KeepAliveResponse(13, timestamp));
            log.info("[Media] 📤 Sending keep-alive response to server: {}", response);
            log.info("[Media] Keep-alive response payload: {}", response);

            // Double-check: using media WebSocket for media keep-alive
            if (conn.getMedia().getSocket() != null) {
                conn.getMedia().getSocket().sendText(response, true);
                log.info("[Media] ✅ Keep-alive response sent successfully via media WebSocket");
            } else {
                log.error("[Media] ❌ ERROR: No media WebSocket available to send keep-alive response!");
            }

        } catch (Exception e) {
            log.error("[Media] ❌ Failed to send keep-alive response: {}", e.getMessage());
        }
    }

    private void handleAudioData(RtmsConnection conn, JsonNode msg) {
        if (msg.has("content")) {
            JsonNode content = msg.get("content");
            // user_id can be integer 0 for mixed audio or a string for specific user
            String userId = content.has("user_id") ? content.get("user_id").asText() : "unknown";
            String userName = content.has("user_name") ? content.get("user_name").asText() : "(mixed audio)";
            log.info("Audio data received from user_id={}, user_name={}", userId, userName);
            // Process audio data here
        }
    }

    private void handleVideoData(RtmsConnection conn, JsonNode msg) {
        if (msg.has("content")) {
            JsonNode content = msg.get("content");
            String userId = content.has("user_id") ? content.get("user_id").asText() : "unknown";
            String userName = content.has("user_name") ? content.get("user_name").asText() : "(no name)";
            log.info("Video data received from user_id={}, user_name={}", userId, userName);
            // Process video data here
        }
    }

    private void handleScreenShareData(RtmsConnection conn, JsonNode msg) {
        log.info("Screenshare data received");
        // Process screenshare data here
    }

    private void handleTranscriptData(RtmsConnection conn, JsonNode msg) {
        if (msg.has("content")) {
            JsonNode content = msg.get("content");
            log.info("Transcript data received: {}", content.toString());
            // Process transcript data here
        } else {
            log.info("Transcript data received (no content)");
        }
    }

    private void handleChatData(RtmsConnection conn, JsonNode msg) {
        JsonNode content = msg.path("content");
        String rawData = content.path("data").asText("");
        try {
            JsonNode chat = rawData.isEmpty() ? objectMapper.createObjectNode() : objectMapper.readTree(rawData);
            JsonNode metadata = content.has("sender") ? content : chat;
            log.info("Chat data received: messageId={}, operationType={}, chatSession={}, sender={}, receiver={}, payload={}",
                    content.has("message_id") ? content.path("message_id").asText(null) : chat.path("message_id").asText(null),
                    content.has("operation_type") ? content.path("operation_type").asInt(0) : chat.path("operation_type").asInt(0),
                    metadata.path("chat_session"),
                    metadata.path("sender"),
                    metadata.path("receiver"),
                    content.has("sender") ? content : chat);
        } catch (Exception e) {
            // Preserve compatibility with older RTMS payloads containing plain UTF-8 chat text.
            log.info("Chat data received: {}", rawData);
        }
    }

    // Comprehensive logging functions matching Node.js implementation
    private void logRtmsStopReason(int errorCode) {
        switch (errorCode) {
            case 0 -> log.info("RTMS stopped: UNDEFINED");
            case 1 -> log.info("RTMS stopped: Host triggered (STOP_BC_HOST_TRIGGERED)");
            case 2 -> log.info("RTMS stopped: User triggered (STOP_BC_USER_TRIGGERED)");
            case 3 -> log.info("RTMS stopped: App user left meeting (STOP_BC_USER_LEFT)");
            case 4 -> log.info("RTMS stopped: App user ejected by host (STOP_BC_USER_EJECTED)");
            case 5 -> log.info("RTMS stopped: App disabled by host (STOP_BC_APP_DISABLED_BY_HOST)");
            case 6 -> log.info("RTMS stopped: Meeting ended (STOP_BC_MEETING_ENDED)");
            case 7 -> log.info("RTMS stopped: Stream canceled by participant (STOP_BC_STREAM_CANCELED)");
            case 8 -> log.info("RTMS stopped: Stream revoked — delete assets immediately (STOP_BC_STREAM_REVOKED)");
            case 9 -> log.info("RTMS stopped: All apps disabled by host (STOP_BC_ALL_APPS_DISABLED)");
            case 10 -> log.info("RTMS stopped: Internal exception (STOP_BC_INTERNAL_EXCEPTION)");
            case 11 -> log.info("RTMS stopped: Connection timeout (STOP_BC_CONNECTION_TIMEOUT)");
            case 12 ->
                log.info("RTMS stopped: Meeting connection interrupted (STOP_BC_MEETING_CONNECTION_INTERRUPTED)");
            case 13 ->
                log.info("RTMS stopped: Signaling connection interrupted (STOP_BC_SIGNAL_CONNECTION_INTERRUPTED)");
            case 14 -> log.info("RTMS stopped: Data connection interrupted (STOP_BC_DATA_CONNECTION_INTERRUPTED)");
            case 15 -> log.info(
                    "RTMS stopped: Signaling connection closed abnormally (STOP_BC_SIGNAL_CONNECTION_CLOSED_ABNORMALLY)");
            case 16 ->
                log.info("RTMS stopped: Data connection closed abnormally (STOP_BC_DATA_CONNECTION_CLOSED_ABNORMALLY)");
            case 17 -> log.info("RTMS stopped: Received exit signal (STOP_BC_EXIT_SIGNAL)");
            case 18 -> log.info("RTMS stopped: Authentication failure (STOP_BC_AUTHENTICATION_FAILURE)");
            default -> log.info("RTMS stopped: Unknown reason code ({})", errorCode);
        }
    }

    private void logRtmsSessionState(int stateCode) {
        switch (stateCode) {
            case 0 -> log.info("Session state: INACTIVE (default)");
            case 1 -> log.info("Session state: INITIALIZE (session is initializing)");
            case 2 -> log.info("Session state: STARTED (session has started)");
            case 3 -> log.info("Session state: PAUSED (session is paused)");
            case 4 -> log.info("Session state: RESUMED (session has resumed)");
            case 5 -> log.info("Session state: STOPPED (session has stopped)");
            default -> log.info("Session state: Unknown state ({})", stateCode);
        }
    }

    private void logRtmsStatusCode(int statusCode) {
        switch (statusCode) {
            case 0 -> log.info("RTMS status: OK");
            case 1 -> log.info("RTMS status: CONNECTION_TIMEOUT");
            case 2 -> log.info("RTMS status: INVALID_JSON_MSG_SIZE");
            case 3 -> log.info("RTMS status: INVALID_JSON_MSG");
            case 4 -> log.info("RTMS status: INVALID_MESSAGE_TYPE");
            case 5 -> log.info("RTMS status: MSG_TYPE_NOT_EXIST");
            case 6 -> log.info("RTMS status: MSG_TYPE_NOT_UINT");
            case 7 -> log.info("RTMS status: MEETING_UUID_NOT_EXIST");
            case 8 -> log.info("RTMS status: MEETING_UUID_NOT_STRING");
            case 9 -> log.info("RTMS status: MEETING_UUID_IS_EMPTY");
            case 10 -> log.info("RTMS status: RTMS_STREAM_ID_NOT_EXIST");
            case 11 -> log.info("RTMS status: RTMS_STREAM_ID_NOT_STRING");
            case 12 -> log.info("RTMS status: RTMS_STREAM_ID_IS_EMPTY");
            case 13 -> log.info("RTMS status: SESSION_NOT_FOUND");
            case 14 -> log.info("RTMS status: SIGNATURE_NOT_EXIST");
            case 15 -> log.info("RTMS status: INVALID_SIGNATURE");
            case 16 -> log.info("RTMS status: INVALID_MEETING_OR_STREAM_ID");
            case 17 -> log.info("RTMS status: DUPLICATE_SIGNAL_REQUEST");
            case 18 -> log.info("RTMS status: EVENTS_NOT_EXIST");
            case 19 -> log.info("RTMS status: EVENTS_VALUE_NOT_ARRAY");
            case 20 -> log.info("RTMS status: EVENT_TYPE_NOT_EXIST");
            case 46 -> log.info("RTMS status: STATUS_INVALID_MEDIA_TRANSCRIPT_TARGET_LANGUAGE");
            case 47 -> log.info("RTMS status: STATUS_CHAT_SESSION_KEY_NOT_AVAILABLE");
            default -> log.info("RTMS status: Unknown status code ({})", statusCode);
        }
    }

    private void subscribeToEvents(RtmsConnection conn) {
        try {
            RtmsMessages.EventSubscriptionRequest subscription = new RtmsMessages.EventSubscriptionRequest(
                    5, List.of(
                            new RtmsMessages.EventSubscriptionRequest.Event(2, true), // ACTIVE_SPEAKER_CHANGE
                            new RtmsMessages.EventSubscriptionRequest.Event(3, true), // PARTICIPANT_JOIN
                            new RtmsMessages.EventSubscriptionRequest.Event(4, true), // PARTICIPANT_LEAVE
                            new RtmsMessages.EventSubscriptionRequest.Event(10, true), // CHAT_GROUP_CREATE
                            new RtmsMessages.EventSubscriptionRequest.Event(11, true), // CHAT_GROUP_DELETE
                            new RtmsMessages.EventSubscriptionRequest.Event(12, true), // CHAT_GROUP_MEMBERS_ADD
                            new RtmsMessages.EventSubscriptionRequest.Event(13, true), // CHAT_GROUP_MEMBERS_DELETE
                            new RtmsMessages.EventSubscriptionRequest.Event(14, true) // CHAT_GROUP_MEMBER_STATUS_UPDATE
                    ));

            String subscriptionMsg = objectMapper.writeValueAsString(subscription);
            log.info("[Signaling] Sending event subscription for {}", conn.getSessionId());
            log.info("[Signaling] Event subscription payload: {}", subscriptionMsg);
            conn.getSignaling().getSocket().sendText(subscriptionMsg, true);
            log.debug("[Signaling] Event subscription sent successfully for {}", conn.getSessionId());

        } catch (Exception e) {
            log.error("[Signaling] Failed to send event subscription for {}: {}", conn.getSessionId(), e.getMessage());
        }
    }

    // Inner WebSocket client classes using Java native WebSocket.Listener

    private class SignalingWebSocketListener implements WebSocket.Listener {

        private final RtmsConnection connection;
        private final StringBuilder textAccumulator = new StringBuilder();

        public SignalingWebSocketListener(RtmsConnection connection) {
            this.connection = connection;
        }

        @Override
        public void onOpen(WebSocket webSocket) {
            webSocket.request(1); // Request one message
            log.info("[Signaling] Java WebSocket opened successfully for {}", connection.getSessionId());

            if (!connection.isShouldReconnect()) {
                log.warn("[Signaling] Aborting open: RTMS stopped for {}", connection.getSessionId());
                webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "RTMS stopped");
                return;
            }

            try {
                log.info("[Signaling] Generating signature for handshake for {}", connection.getSessionId());
                String signature = generateSignature(connection.getSessionId(), connection.getStreamId());
                log.info("[Signaling] Signature generated successfully for {}", connection.getSessionId());

                RtmsMessages.SignalingHandshakeRequest handshakeReq = new RtmsMessages.SignalingHandshakeRequest(
                        1, connection.getSessionId(), connection.getSessionId(), connection.getStreamId(), signature, false);

                String handshakeMsg = objectMapper.writeValueAsString(handshakeReq);
                log.info("[Signaling] Sending handshake for {}", connection.getSessionId());
                log.info("[Signaling] Handshake payload: {}", handshakeMsg);
                webSocket.sendText(handshakeMsg, true);
                connection.getSignaling().setState(RtmsConnection.SignalingConnection.SignalingState.AUTHENTICATED);
                log.info("[Signaling] Connection state updated to 'authenticated' for {}", connection.getSessionId());

            } catch (Exception e) {
                log.error("[Signaling] Error in Java WebSocket open handler for {}: {}", connection.getSessionId(),
                        e.getMessage());
                connection.getSignaling().setState(RtmsConnection.SignalingConnection.SignalingState.DISCONNECTED);
                webSocket.sendClose(1011, "Handshake error");
            }
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            webSocket.request(1); // Request next message

            textAccumulator.append(data);
            if (last) {
                String completeMessage = textAccumulator.toString();
                textAccumulator.setLength(0); // Clear for next message
                processSignalingMessage(connection, completeMessage);
            }
            return null;
        }

        @Override
        public CompletionStage<?> onBinary(WebSocket webSocket, ByteBuffer data, boolean last) {
            webSocket.request(1);

            try {
                byte[] bytes = new byte[data.remaining()];
                data.get(bytes);
                String textMessage = new String(bytes, StandardCharsets.UTF_8);
                processSignalingMessage(connection, textMessage);
            } catch (Exception e) {
                log.error("[Signaling] Failed to process binary message: {}", e.getMessage());
            }
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            log.info("Signaling Java WebSocket closed for session {}: {} - {}", connection.getSessionId(), statusCode,
                    reason);
            signalingHandshakeLocks.remove(connection.getStreamId());
            connection.getSignaling().setState(RtmsConnection.SignalingConnection.SignalingState.DISCONNECTED);

            if (!connection.isShouldReconnect()) {
                log.debug("Not reconnecting — RTMS was stopped.");
            } else {
                // Check connection state before attempting reconnection
                RtmsConnection currentConn = activeConnections.get(connection.getSessionId());
                if (!signalingHasConnection() && currentConn != null && currentConn.isShouldReconnect()) {
                    log.info("Attempting reconnection for signaling Java WebSocket in 3s...");
                    try {
                        Thread.sleep(3000);
                        connectToSignalingWebSocket(currentConn);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                } else {
                    log.warn("Skipping reconnection - active connection exists or connection not valid");
                }
            }
            return null;
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            log.error("Signaling Java WebSocket error for session {}: {}", connection.getSessionId(),
                    error.getMessage());
            log.error("Java WebSocket failure details:", error);
            signalingHandshakeLocks.remove(connection.getStreamId());
            connection.getSignaling().setState(RtmsConnection.SignalingConnection.SignalingState.DISCONNECTED);
        }

        private boolean signalingHasConnection() {
            return connection.getSignaling().getSocket() != null;
        }
    }

    private class MediaWebSocketListener implements WebSocket.Listener {

        private final RtmsConnection connection;
        private final String mediaUrl;
        private final StringBuilder textAccumulator = new StringBuilder();

        public MediaWebSocketListener(RtmsConnection connection, String mediaUrl) {
            this.connection = connection;
            this.mediaUrl = mediaUrl;
        }

        @Override
        public void onOpen(WebSocket webSocket) {
            webSocket.request(1); // Request one message
            log.info("[Media] Java WebSocket opened successfully for {}", connection.getSessionId());

            if (!connection.isShouldReconnect()) {
                log.warn("[Media] Aborting open: RTMS stopped for {}", connection.getSessionId());
                webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "RTMS stopped");
                return;
            }

            try {
                log.info("[Media] Generating signature for handshake for {}", connection.getSessionId());
                String signature = generateSignature(connection.getSessionId(), connection.getStreamId());
                log.info("[Media] Signature generated successfully for {}", connection.getSessionId());

                // Media handshake with parameters (msg_type: 3)
                RtmsMessages.DataHandshakeRequest handshakeReq = new RtmsMessages.DataHandshakeRequest(
                        3, 1, connection.getSessionId(), connection.getSessionId(),
                        connection.getStreamId(), signature, 32, false,
                        new RtmsMessages.MediaParams(
                                new RtmsMessages.AudioParams(1, 1, 1, 1, 2, 20),
                                new RtmsMessages.VideoParams(7, 3, 2, 25),
                                new RtmsMessages.DeskshareParams(5, 2, 1),
                                new RtmsMessages.TranscriptParams(5),
                                new RtmsMessages.ChatParams(5)));

                String handshakeMsg = objectMapper.writeValueAsString(handshakeReq);
                log.info("[Media] Sending handshake for {}", connection.getSessionId());
                log.info("[Media] Handshake payload: {}", handshakeMsg);
                webSocket.sendText(handshakeMsg, true);
                connection.getMedia().setState(RtmsConnection.MediaConnection.MediaState.AUTHENTICATED);
                log.info("[Media] Connection state updated to 'authenticated' for {}", connection.getSessionId());

            } catch (Exception e) {
                log.error("[Media] Error in Java WebSocket open handler for {}: {}", connection.getSessionId(),
                        e.getMessage());
                connection.getMedia().setState(RtmsConnection.MediaConnection.MediaState.ERROR);
                webSocket.sendClose(1011, "Handshake error");
            }
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            webSocket.request(1); // Request next message

            textAccumulator.append(data);
            if (last) {
                String completeMessage = textAccumulator.toString();
                textAccumulator.setLength(0); // Clear for next message
                processMediaMessage(connection, completeMessage);
            }
            return null;
        }

        @Override
        public CompletionStage<?> onBinary(WebSocket webSocket, ByteBuffer data, boolean last) {
            webSocket.request(1);

            try {
                byte[] bytes = new byte[data.remaining()];
                data.get(bytes);
                String textMessage = new String(bytes, StandardCharsets.UTF_8);
                processMediaMessage(connection, textMessage);
            } catch (Exception e) {
                log.error("[Media] Failed to process binary message: {}", e.getMessage());
            }
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            log.info("Media Java WebSocket closed for session {}: {} - {}", connection.getSessionId(), statusCode,
                    reason);
            connection.getMedia().setState(RtmsConnection.MediaConnection.MediaState.CLOSED);

            if (!connection.isShouldReconnect()) {
                log.debug("Not reconnecting — RTMS was stopped.");
            } else {
                // Check if connection is still valid before attempting reconnection
                RtmsConnection currentConn = activeConnections.get(connection.getSessionId());
                if (currentConn == null || !currentConn.isShouldReconnect()) {
                    log.debug("Connection no longer valid or reconnection disabled");
                    return null;
                }

                if (connection.getSignaling().getState() == RtmsConnection.SignalingConnection.SignalingState.READY) {
                    // Check if media connection already exists
                    boolean mediaHasConnection = mediaHasConnection();
                    if (!mediaHasConnection) {
                        log.info("Reconnecting media Java WebSocket in 3s...");
                        try {
                            Thread.sleep(3000);
                            connectToMediaWebSocket(currentConn, mediaUrl);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    } else {
                        log.warn("Skipping media reconnection - active connection exists");
                    }
                } else {
                    log.warn("Signaling not ready, restarting both connections...");
                    connectToSignalingWebSocket(currentConn);
                }
            }
            return null;
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            log.error("Media Java WebSocket error for session {}: {}", connection.getSessionId(), error.getMessage());
            log.error("Java Media WebSocket failure details:", error);
            connection.getMedia().setState(RtmsConnection.MediaConnection.MediaState.ERROR);
        }

        private boolean mediaHasConnection() {
            return connection.getMedia().getSocket() != null;
        }
    }
}
