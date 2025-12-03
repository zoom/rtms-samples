package com.zoom.rtms.vsdkworkingjava.service;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import okhttp3.WebSocket;

@Data
@Builder
public class RtmsConnection {
    private final String sessionId;
    private final String streamId;
    private final String serverUrls;
    private volatile boolean shouldReconnect = true;

    private SignalingConnection signaling;
    private MediaConnection media;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class SignalingConnection {
        private SignalingState state = SignalingState.DISCONNECTED;
        private long lastKeepAlive = 0;
        private WebSocket socket;

        public enum SignalingState {
            DISCONNECTED, CONNECTING, AUTHENTICATED, READY
        }
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class MediaConnection {
        private MediaState state = MediaState.IDLE;
        private long lastKeepAlive = 0;
        private WebSocket socket;

        public enum MediaState {
            IDLE, CONNECTING, AUTHENTICATED, STREAMING, CLOSED, ERROR
        }
    }
}
