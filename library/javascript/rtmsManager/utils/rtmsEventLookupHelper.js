// Example: to log handshake response
export function getHandshakeResponse(errorCode) {

}


export function getRtmsSessionState(stateCode) {
  switch (stateCode) {
    case 0:
      return 'Session state: INACTIVE (default)';
    case 1:
      return 'Session state: INITIALIZE (session is initializing)';
    case 2:
      return 'Session state: STARTED (session has started)';
    case 3:
      return 'Session state: PAUSED (session is paused)';
    case 4:
      return 'Session state: RESUMED (session has resumed)';
    case 5:
      return 'Session state: STOPPED (session has stopped)';
    default:
      return `Session state: Unknown state (${stateCode})`;
  }
}



export function getRtmsStreamState(stateCode) {
  switch (stateCode) {
    case 0:
      return 'Stream state: INACTIVE (default state)';
    case 1:
      return 'Stream state: ACTIVE (media is being transmitted)';
    case 2:
      return 'Stream state: INTERRUPTED (connection issue detected)';
    case 3:
      return 'Stream state: TERMINATING (client notified to terminate)';
    case 4:
      return 'Stream state: TERMINATED (stream has ended)';
    case 5:
      return 'Stream state: PAUSED';
    case 6:
      return 'Stream state: RESUMED';
    default:
      return `Stream state: Unknown state (${stateCode})`;
  }
}



//used for both reason and stop_reason error code
export function getRtmsStopReason(errorCode) {
  switch (errorCode) {
    case 0:
      return 'RTMS stopped: UNDEFINED';
    case 1:
      return 'RTMS stopped: Host triggered (STOP_BC_HOST_TRIGGERED)';
    case 2:
      return 'RTMS stopped: User triggered (STOP_BC_USER_TRIGGERED)';
    case 3:
      return 'RTMS stopped: App user left meeting (STOP_BC_USER_LEFT)';
    case 4:
      return 'RTMS stopped: App user ejected by host (STOP_BC_USER_EJECTED)';
    case 5:
      return 'RTMS stopped: Host disabled app (STOP_BC_HOST_DISABLED_APP)';
    case 6:
      return 'RTMS stopped: Meeting ended (STOP_BC_MEETING_ENDED)';
    case 7:
      return 'RTMS stopped: Stream canceled by participant (STOP_BC_STREAM_CANCELED)';
    case 8:
      return 'RTMS stopped: Stream revoked — delete assets immediately (STOP_BC_STREAM_REVOKED)';
    case 9:
      return 'RTMS stopped: All apps disabled by host (STOP_BC_ALL_APPS_DISABLED)';
    case 10:
      return 'RTMS stopped: Internal exception (STOP_BC_INTERNAL_EXCEPTION)';
    case 11:
      return 'RTMS stopped: Connection timeout (STOP_BC_CONNECTION_TIMEOUT)';
    case 12:
      return 'RTMS stopped: Instance connection interrupted (STOP_BC_INSTANCE_CONNECTION_INTERRUPTED)';
    case 13:
      return 'RTMS stopped: Signaling connection interrupted (STOP_BC_SIGNAL_CONNECTION_INTERRUPTED)';
    case 14:
      return 'RTMS stopped: Data connection interrupted (STOP_BC_DATA_CONNECTION_INTERRUPTED)';
    case 15:
      return 'RTMS stopped: Signaling connection closed abnormally (STOP_BC_SIGNAL_CONNECTION_CLOSED_ABNORMALLY)';
    case 16:
      return 'RTMS stopped: Data connection closed abnormally (STOP_BC_DATA_CONNECTION_CLOSED_ABNORMALLY)';
    case 17:
      return 'RTMS stopped: Received exit signal (STOP_BC_EXIT_SIGNAL)';
    case 18:
      return 'RTMS stopped: Authentication failure (STOP_BC_AUTHENTICATION_FAILURE)';
    case 19:
      return 'RTMS stopped: Await reconnection timeout (STOP_BC_AWAIT_RECONNECTION_TIMEOUT)';
    case 20:
      return 'RTMS stopped: Receiver requested close (STOP_BC_RECEIVER_REQUEST_CLOSE)';
    case 21:
      return 'RTMS stopped: Customer disconnected (STOP_BC_CUSTOMER_DISCONNECTED)';
    case 22:
      return 'RTMS stopped: Agent disconnected (STOP_BC_AGENT_DISCONNECTED)';
    case 23:
      return 'RTMS stopped: Admin disabled app (STOP_BC_ADMIN_DISABLED_APP)';
    case 24:
      return 'RTMS stopped: Keep-alive timeout (STOP_BC_KEEP_ALIVE_TIMEOUT)';
    case 25:
      return 'RTMS stopped: Manual API triggered (STOP_BC_MANUAL_API_TRIGGERED)';
    case 26:
      return 'RTMS stopped: Streaming not supported (STOP_BC_STREAMING_NOT_SUPPORTED)';
    default:
      return `RTMS stopped: Unknown reason code (${errorCode})`;
  }
}

export function getRtmsStatusCode(statusCode) {
  switch (statusCode) {
    case 0:
      return 'RTMS status: OK';
    case 1:
      return 'RTMS status: INVALID_MESSAGE_TYPE';
    case 2:
      return 'RTMS status: INVALID_RTMS_STREAM_ID';
    case 3:
      return 'RTMS status: INVALID_SIGNATURE';
    case 4:
      return 'RTMS status: INVALID_PAYLOAD';
    case 5:
      return 'RTMS status: INVALID_EVENTS';
    case 6:
      return 'RTMS status: INVALID_EVENT_TYPE';
    case 7:
      return 'RTMS status: INVALID_MEDIA_TYPE';
    case 8:
      return 'RTMS status: DUPLICATE_SIGNAL_REQUEST';
    case 9:
      return 'RTMS status: MEDIA_TYPE_AUDIO_NOT_SUPPORT';
    case 10:
      return 'RTMS status: MEDIA_TYPE_VIDEO_NOT_SUPPORT';
    case 11:
      return 'RTMS status: MEDIA_TYPE_DESKSHARE_NOT_SUPPORT';
    case 12:
      return 'RTMS status: MEDIA_TYPE_TRANSCRIPT_NOT_SUPPORT';
    case 13:
      return 'RTMS status: MEDIA_TYPE_CHAT_NOT_SUPPORT';
    case 14:
      return 'RTMS status: MEDIA_TYPE_INVALID_VALUE';
    case 15:
      return 'RTMS status: MEDIA_DATA_ALL_CONNECTION_EXIST';
    case 16:
      return 'RTMS status: DUPLICATE_MEDIA_DATA_CONNECTION';
    case 17:
      return 'RTMS status: INVALID_MEDIA_PARAMS';
    case 18:
      return 'RTMS status: INVALID_MEDIA_AUDIO_PARAMS';
    case 19:
      return 'RTMS status: INVALID_MEDIA_AUDIO_CONTENT_TYPE';
    case 20:
      return 'RTMS status: INVALID_MEDIA_AUDIO_SAMPLE_RATE';
    case 21:
      return 'RTMS status: INVALID_MEDIA_AUDIO_CHANNEL';
    case 22:
      return 'RTMS status: INVALID_MEDIA_AUDIO_CODEC';
    case 23:
      return 'RTMS status: INVALID_MEDIA_AUDIO_DATA_OPT';
    case 24:
      return 'RTMS status: INVALID_MEDIA_AUDIO_SEND_RATE';
    case 25:
      return 'RTMS status: INVALID_MEDIA_VIDEO_PARAMS';
    case 26:
      return 'RTMS status: INVALID_MEDIA_VIDEO_CONTENT_TYPE';
    case 27:
      return 'RTMS status: INVALID_MEDIA_VIDEO_CODEC';
    case 28:
      return 'RTMS status: INVALID_MEDIA_VIDEO_RESOLUTION';
    case 29:
      return 'RTMS status: INVALID_MEDIA_VIDEO_DATA_OPT';
    case 30:
      return 'RTMS status: INVALID_MEDIA_VIDEO_FPS';
    case 31:
      return 'RTMS status: INVALID_MEDIA_DESKSHARE_PARAMS';
    case 32:
      return 'RTMS status: INVALID_MEDIA_DESKSHARE_CONTENT_TYPE';
    case 33:
      return 'RTMS status: INVALID_MEDIA_DESKSHARE_CODEC';
    case 34:
      return 'RTMS status: INVALID_MEDIA_DESKSHARE_RESOLUTION';
    case 35:
      return 'RTMS status: INVALID_MEDIA_DESKSHARE_FPS';
    case 36:
      return 'RTMS status: INVALID_MEDIA_TRANSCRIPT_PARAMS';
    case 37:
      return 'RTMS status: INVALID_MEDIA_TRANSCRIPT_CONTENT_TYPE';
    case 38:
      return 'RTMS status: INVALID_MEDIA_CHAT_PARAMS';
    case 39:
      return 'RTMS status: INVALID_MEDIA_CHAT_CONTENT_TYPE';
    case 40:
      return 'RTMS status: INVALID_RTMS_SESSION_ID';
    case 41:
      return 'RTMS status: INVALID_CLIENT_READY_ACK';
    case 42:
      return 'RTMS status: INVALID_EVENT_SUBSCRIBE';
    case 43:
      return 'RTMS status: INVALID_MEDIA_TRANSCRIPT_SROUCE_LANGUAGE';
    default:
      return `RTMS status: Unknown status code (${statusCode})`;
  }
}
