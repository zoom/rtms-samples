package com.zoom.rtms.workingjava.model;

public class RtmsStates {

    public enum SessionState {
        INACTIVE(0, "Session state: INACTIVE (default)"),
        INITIALIZE(1, "Session state: INITIALIZE (session is initializing)"),
        STARTED(2, "Session state: STARTED (session has started)"),
        PAUSED(3, "Session state: PAUSED (session is paused)"),
        RESUMED(4, "Session state: RESUMED (session has resumed)"),
        STOPPED(5, "Session state: STOPPED (session has stopped)");

        private final int code;
        private final String message;

        SessionState(int code, String message) {
            this.code = code;
            this.message = message;
        }

        public static String getStateMessage(int code) {
            for (SessionState state : values()) {
                if (state.code == code) {
                    return state.message;
                }
            }
            return "Session state: Unknown state (" + code + ")";
        }
    }

    public enum StreamState {
        INACTIVE(0, "Stream state: INACTIVE (default state)"),
        ACTIVE(1, "Stream state: ACTIVE (media is being transmitted)"),
        INTERRUPTED(2, "Stream state: INTERRUPTED (connection issue detected)"),
        TERMINATING(3, "Stream state: TERMINATING (client notified to terminate)"),
        TERMINATED(4, "Stream state: TERMINATED (stream has ended)");

        private final int code;
        private final String message;

        StreamState(int code, String message) {
            this.code = code;
            this.message = message;
        }

        public static String getStateMessage(int code) {
            for (StreamState state : values()) {
                if (state.code == code) {
                    return state.message;
                }
            }
            return "Stream state: Unknown state (" + code + ")";
        }
    }

    public enum StopReason {
        UNDEFINED(0, "RTMS stopped: UNDEFINED"),
        HOST_TRIGGERED(1, "RTMS stopped: Host triggered (STOP_BC_HOST_TRIGGERED)"),
        USER_TRIGGERED(2, "RTMS stopped: User triggered (STOP_BC_USER_TRIGGERED)"),
        USER_LEFT(3, "RTMS stopped: App user left meeting (STOP_BC_USER_LEFT)"),
        USER_EJECTED(4, "RTMS stopped: App user ejected by host (STOP_BC_USER_EJECTED)"),
        APP_DISABLED_BY_HOST(5, "RTMS stopped: App disabled by host (STOP_BC_APP_DISABLED_BY_HOST)"),
        MEETING_ENDED(6, "RTMS stopped: Meeting ended (STOP_BC_MEETING_ENDED)"),
        STREAM_CANCELED(7, "RTMS stopped: Stream canceled by participant (STOP_BC_STREAM_CANCELED)"),
        STREAM_REVOKED(8, "RTMS stopped: Stream revoked — delete assets immediately (STOP_BC_STREAM_REVOKED)"),
        ALL_APPS_DISABLED(9, "RTMS stopped: All apps disabled by host (STOP_BC_ALL_APPS_DISABLED)"),
        INTERNAL_EXCEPTION(10, "RTMS stopped: Internal exception (STOP_BC_INTERNAL_EXCEPTION)"),
        CONNECTION_TIMEOUT(11, "RTMS stopped: Connection timeout (STOP_BC_CONNECTION_TIMEOUT)"),
        MEETING_CONNECTION_INTERRUPTED(12, "RTMS stopped: Meeting connection interrupted (STOP_BC_MEETING_CONNECTION_INTERRUPTED)"),
        SIGNALING_CONNECTION_INTERRUPTED(13, "RTMS stopped: Signaling connection interrupted (STOP_BC_SIGNAL_CONNECTION_INTERRUPTED)"),
        DATA_CONNECTION_INTERRUPTED(14, "RTMS stopped: Data connection interrupted (STOP_BC_DATA_CONNECTION_INTERRUPTED)"),
        SIGNALING_CONNECTION_CLOSED_ABNORMALLY(15, "RTMS stopped: Signaling connection closed abnormally (STOP_BC_SIGNAL_CONNECTION_CLOSED_ABNORMALLY)"),
        DATA_CONNECTION_CLOSED_ABNORMALLY(16, "RTMS stopped: Data connection closed abnormally (STOP_BC_DATA_CONNECTION_CLOSED_ABNORMALLY)"),
        EXIT_SIGNAL(17, "RTMS stopped: Received exit signal (STOP_BC_EXIT_SIGNAL)"),
        AUTHENTICATION_FAILURE(18, "RTMS stopped: Authentication failure (STOP_BC_AUTHENTICATION_FAILURE)");

        private final int code;
        private final String message;

        StopReason(int code, String message) {
            this.code = code;
            this.message = message;
        }

        public static String getStopReasonMessage(int code) {
            for (StopReason reason : values()) {
                if (reason.code == code) {
                    return reason.message;
                }
            }
            return "RTMS stopped: Unknown reason code (" + code + ")";
        }
    }

    public enum EventType {
        UNDEFINED(0, "UNDEFINED event received"),
        FIRST_PACKET_TIMESTAMP(1, "FIRST_PACKET_TIMESTAMP — first media packet at"),
        ACTIVE_SPEAKER_CHANGE(2, "ACTIVE_SPEAKER_CHANGE"),
        PARTICIPANT_JOIN(3, "PARTICIPANT_JOIN"),
        PARTICIPANT_LEAVE(4, "PARTICIPANT_LEAVE"),
        CHAT_GROUP_CREATE(10, "CHAT_GROUP_CREATE"),
        CHAT_GROUP_DELETE(11, "CHAT_GROUP_DELETE"),
        CHAT_GROUP_MEMBERS_ADD(12, "CHAT_GROUP_MEMBERS_ADD"),
        CHAT_GROUP_MEMBERS_DELETE(13, "CHAT_GROUP_MEMBERS_DELETE"),
        CHAT_GROUP_MEMBER_STATUS_UPDATE(14, "CHAT_GROUP_MEMBER_STATUS_UPDATE");

        private final int code;
        private final String description;

        EventType(int code, String description) {
            this.code = code;
            this.description = description;
        }

        public static String getEventDescription(int code) {
            for (EventType event : values()) {
                if (event.code == code) {
                    return event.description;
                }
            }
            return "Unknown event_type: " + code;
        }
    }
}
