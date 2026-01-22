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
      return 'RTMS stopped: App disabled by host (STOP_BC_APP_DISABLED_BY_HOST)';
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
      return 'RTMS stopped: Meeting connection interrupted (STOP_BC_MEETING_CONNECTION_INTERRUPTED)';
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
    default:
      return `RTMS stopped: Unknown reason code (${errorCode})`;
  }
}

export function getRtmsStatusCode(statusCode) {
  switch (statusCode) {
    case 0:
      return 'RTMS status: OK';
    case 1:
      return 'RTMS status: CONNECTION_TIMEOUT';
    case 2:
      return 'RTMS status: INVALID_JSON_MSG_SIZE';
    case 3:
      return 'RTMS status: INVALID_JSON_MSG';
    case 4:
      return 'RTMS status: INVALID_MESSAGE_TYPE';
    case 5:
      return 'RTMS status: MSG_TYPE_NOT_EXIST';
    case 6:
      return 'RTMS status: MSG_TYPE_NOT_UINT';
    case 7:
      return 'RTMS status: MEETING_UUID_NOT_EXIST';
    case 8:
      return 'RTMS status: MEETING_UUID_NOT_STRING';
    case 9:
      return 'RTMS status: MEETING_UUID_IS_EMPTY';
    case 10:
      return 'RTMS status: RTMS_STREAM_ID_NOT_EXIST';
    case 11:
      return 'RTMS status: RTMS_STREAM_ID_NOT_STRING';
    case 12:
      return 'RTMS status: RTMS_STREAM_ID_IS_EMPTY';
    case 13:
      return 'RTMS status: SESSION_NOT_FOUND';
    case 14:
      return 'RTMS status: SIGNATURE_NOT_EXIST';
    case 15:
      return 'RTMS status: INVALID_SIGNATURE';
    case 16:
      return 'RTMS status: INVALID_MEETING_OR_STREAM_ID';
    case 17:
      return 'RTMS status: DUPLICATE_SIGNAL_REQUEST';
    case 18:
      return 'RTMS status: EVENTS_NOT_EXIST';
    case 19:
      return 'RTMS status: EVENTS_VALUE_NOT_ARRAY';
    case 20:
      return 'RTMS status: EVENT_TYPE_NOT_EXIST';
    case 21:
      return 'RTMS status: EVENT_TYPE_VALUE_NOT_UINT';
    case 22:
      return 'RTMS status: MEDIA_TYPE_NOT_EXIST';
    case 23:
      return 'RTMS status: MEDIA_TYPE_NOT_UINT';
    case 24:
      return 'RTMS status: MEDIA_TYPE_AUDIO_NOT_SUPPORT';
    case 25:
      return 'RTMS status: MEDIA_TYPE_VIDEO_NOT_SUPPORT';
    case 26:
      return 'RTMS status: MEDIA_TYPE_DESKSHARE_NOT_SUPPORT';
    case 27:
      return 'RTMS status: MEDIA_TYPE_TRANSCRIPT_NOT_SUPPORT';
    case 28:
      return 'RTMS status: MEDIA_TYPE_CHAT_NOT_SUPPORT';
    case 29:
      return 'RTMS status: MEDIA_TYPE_INVALID_VALUE';
    case 30:
      return 'RTMS status: MEDIA_DATA_ALL_CONNECTION_EXIST';
    case 31:
      return 'RTMS status: DUPLICATE_MEDIA_DATA_CONNECTION';
    case 32:
      return 'RTMS status: MEDIA_PARAMS_NOT_EXIST';
    case 33:
      return 'RTMS status: INVALID_MEDIA_PARAMS';
    case 34:
      return 'RTMS status: NO_MEDIA_TYPE_SPECIFIED';
    case 35:
      return 'RTMS status: INVALID_MEDIA_AUDIO_PARAMS';
    case 36:
      return 'RTMS status: MEDIA_AUDIO_CONTENT_TYPE_NOT_UINT';
    case 37:
      return 'RTMS status: INVALID_MEDIA_AUDIO_CONTENT_TYPE';
    case 38:
      return 'RTMS status: MEDIA_AUDIO_SAMPLE_RATE_NOT_UINT';
    case 39:
      return 'RTMS status: INVALID_MEDIA_AUDIO_SAMPLE_RATE';
    case 40:
      return 'RTMS status: MEDIA_AUDIO_CHANNEL_NOT_UINT';
    case 41:
      return 'RTMS status: INVALID_MEDIA_AUDIO_CHANNEL';
    case 42:
      return 'RTMS status: MEDIA_AUDIO_CODEC_NOT_UINT';
    case 43:
      return 'RTMS status: INVALID_MEDIA_AUDIO_CODEC';
    case 44:
      return 'RTMS status: MEDIA_AUDIO_DATA_OPT_NOT_UINT';
    case 45:
      return 'RTMS status: INVALID_MEDIA_AUDIO_DATA_OPT';
    case 46:
      return 'RTMS status: MEDIA_AUDIO_SEND_RATE_NOT_UINT';
    case 47:
      return 'RTMS status: MEDIA_AUDIO_FRAME_SIZE_NOT_UINT';
    case 48:
      return 'RTMS status: INVALID_MEDIA_VIDEO_PARAMS';
    case 49:
      return 'RTMS status: INVALID_MEDIA_VIDEO_CONTENT_TYPE';
    case 50:
      return 'RTMS status: MEDIA_VIDEO_CONTENT_TYPE_NOT_UINT';
    case 51:
      return 'RTMS status: INVALID_MEDIA_VIDEO_CODEC';
    case 52:
      return 'RTMS status: MEDIA_VIDEO_CODEC_NOT_UINT';
    case 53:
      return 'RTMS status: INVALID_MEDIA_VIDEO_RESOLUTION';
    case 54:
      return 'RTMS status: MEDIA_VIDEO_RESOLUTION_NOT_UINT';
    case 55:
      return 'RTMS status: INVALID_MEDIA_VIDEO_DATA_OPT';
    case 56:
      return 'RTMS status: MEDIA_VIDEO_DATA_OPT_NOT_UINT';
    case 57:
      return 'RTMS status: MEDIA_VIDEO_FPS_NOT_UINT';
    case 58:
      return 'RTMS status: INVALID_MEDIA_SHARE_PARAMS';
    case 59:
      return 'RTMS status: INVALID_AUDIO_DATA_BUFFER';
    case 60:
      return 'RTMS status: INVALID_VIDEO_DATA_BUFFER';
    case 61:
      return 'RTMS status: POST_FIRST_PACKET_FAILURE';
    case 62:
      return 'RTMS status: RTMS_SESSION_NOT_FOUND';
    default:
      return `RTMS status: Unknown status code (${statusCode})`;
  }
}
