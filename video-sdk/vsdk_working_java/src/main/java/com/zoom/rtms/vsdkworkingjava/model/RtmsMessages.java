package com.zoom.rtms.vsdkworkingjava.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;
import java.util.Map;

public class RtmsMessages {

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SignalingHandshakeRequest(
            @JsonProperty("msg_type") int msgType, // 1
            @JsonProperty("meeting_uuid") String meetingUuid,
            @JsonProperty("session_id") String sessionId,
            @JsonProperty("rtms_stream_id") String rtmsStreamId,
            String signature
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SignalingHandshakeResponse(
            @JsonProperty("msg_type") int msgType, // 2
            @JsonProperty("status_code") int statusCode,
            @JsonProperty("media_server") MediaServer mediaServer,
            Integer reason
    ) {
        public record MediaServer(
                @JsonProperty("server_urls") ServerUrls serverUrls
        ) {
            public record ServerUrls(
                    String all,
                    String audio
            ) {}
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record DataHandshakeRequest(
            @JsonProperty("msg_type") int msgType, // 3
            @JsonProperty("protocol_version") int protocolVersion,
            @JsonProperty("meeting_uuid") String meetingUuid,
            @JsonProperty("session_id") String sessionId,
            @JsonProperty("rtms_stream_id") String rtmsStreamId,
            String signature,
            @JsonProperty("media_type") int mediaType,
            @JsonProperty("payload_encryption") boolean payloadEncryption,
            @JsonProperty("media_params") MediaParams mediaParams
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record DataHandshakeResponse(
            @JsonProperty("msg_type") int msgType, // 4
            @JsonProperty("status_code") int statusCode,
            Integer reason
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record EventSubscriptionRequest(
            @JsonProperty("msg_type") int msgType, // 5
            List<Event> events
    ) {
        public record Event(
                @JsonProperty("event_type") int eventType,
                boolean subscribe
        ) {}
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record EventMessage(
            @JsonProperty("msg_type") int msgType, // 6
            @JsonProperty("timestamp") long timestamp,
            ZoomEvent event
    ) {
        public record ZoomEvent(
                @JsonProperty("event_type") int eventType,
                @JsonProperty("user_id") String userId,
                @JsonProperty("user_name") String userName,
                Long timestamp
        ) {}
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ReadyNotification(
            @JsonProperty("msg_type") int msgType, // 7
            @JsonProperty("rtms_stream_id") String rtmsStreamId
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record StreamStateChange(
            @JsonProperty("msg_type") int msgType, // 8
            String state,
            Integer reason,
            @JsonProperty("stop_reason") Integer stopReason
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SessionStateChange(
            @JsonProperty("msg_type") int msgType, // 9
            String state,
            Integer reason,
            @JsonProperty("stop_reason") Integer stopReason
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record KeepAliveRequest(
            @JsonProperty("msg_type") int msgType, // 12
            @JsonProperty("timestamp") long timestamp
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record KeepAliveResponse(
            @JsonProperty("msg_type") int msgType, // 13
            @JsonProperty("timestamp") long timestamp
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record MediaMessageRecord(
            @JsonProperty("msg_type") int msgType,
            MediaContent content
    ) {
        public record MediaContent(
                @JsonProperty("user_id") String userId,
                @JsonProperty("user_name") String userName,
                String data,
                Long timestamp
        ) {}
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record MediaParams(
            AudioParams audio,
            VideoParams video,
            DeskshareParams deskshare,
            TranscriptParams transcript,
            ChatParams chat
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record AudioParams(
            @JsonProperty("content_type") int contentType,
            @JsonProperty("sample_rate") int sampleRate,
            int channel,
            int codec,
            @JsonProperty("data_opt") int dataOpt,
            @JsonProperty("send_rate") int sendRate
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record VideoParams(
            int codec,
            @JsonProperty("data_opt") int dataOpt,
            int resolution,
            int fps
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record DeskshareParams(
            int codec,
            int resolution,
            int fps
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record TranscriptParams(
            @JsonProperty("content_type") int contentType
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ChatParams(
            @JsonProperty("content_type") int contentType
    ) {}
}
