// Example: to log handshake response
export function logHandshakeResponse(errorCode) {

}


export function logRtmsSessionState(stateCode) {
  switch (stateCode) {
    case 0:
      console.log('Session state: INACTIVE (default)');
      break;
    case 1:
      console.log('Session state: INITIALIZE (session is initializing)');
      break;
    case 2:
      console.log('Session state: STARTED (session has started)');
      break;
    case 3:
      console.log('Session state: PAUSED (session is paused)');
      break;
    case 4:
      console.log('Session state: RESUMED (session has resumed)');
      break;
    case 5:
      console.log('Session state: STOPPED (session has stopped)');
      break;
    default:
      console.log(`Session state: Unknown state (${stateCode})`);
  }
}



export function logRtmsStreamState(stateCode) {
  switch (stateCode) {
    case 0:
      console.log('Stream state: INACTIVE (default state)');
      break;
    case 1:
      console.log('Stream state: ACTIVE (media is being transmitted)');
      break;
    case 2:
      console.log('Stream state: INTERRUPTED (connection issue detected)');
      break;
    case 3:
      console.log('Stream state: TERMINATING (client notified to terminate)');
      break;
    case 4:
      console.log('Stream state: TERMINATED (stream has ended)');
      break;
    default:
      console.log(`Stream state: Unknown state (${stateCode})`);
  }
}

//used for both reason and stop_reason error code
export function logRtmsStopReason(errorCode) {
  switch (errorCode) {
    case 0:
      console.log('RTMS stopped: UNDEFINED');
      break;
    case 1:
      console.log('RTMS stopped: Host triggered (STOP_BC_HOST_TRIGGERED)');
      break;
    case 2:
      console.log('RTMS stopped: User triggered (STOP_BC_USER_TRIGGERED)');
      break;
    case 3:
      console.log('RTMS stopped: App user left meeting (STOP_BC_USER_LEFT)');
      break;
    case 4:
      console.log('RTMS stopped: App user ejected by host (STOP_BC_USER_EJECTED)');
      break;
    case 5:
      console.log('RTMS stopped: App disabled by host (STOP_BC_APP_DISABLED_BY_HOST)');
      break;
    case 6:
      console.log('RTMS stopped: Meeting ended (STOP_BC_MEETING_ENDED)');
      break;
    case 7:
      console.log('RTMS stopped: Stream canceled by participant (STOP_BC_STREAM_CANCELED)');
      break;
    case 8:
      console.log('RTMS stopped: Stream revoked — delete assets immediately (STOP_BC_STREAM_REVOKED)');
      break;
    case 9:
      console.log('RTMS stopped: All apps disabled by host (STOP_BC_ALL_APPS_DISABLED)');
      break;
    case 10:
      console.log('RTMS stopped: Internal exception (STOP_BC_INTERNAL_EXCEPTION)');
      break;
    case 11:
      console.log('RTMS stopped: Connection timeout (STOP_BC_CONNECTION_TIMEOUT)');
      break;
    case 12:
      console.log('RTMS stopped: Meeting connection interrupted (STOP_BC_MEETING_CONNECTION_INTERRUPTED)');
      break;
    case 13:
      console.log('RTMS stopped: Signaling connection interrupted (STOP_BC_SIGNAL_CONNECTION_INTERRUPTED)');
      break;
    case 14:
      console.log('RTMS stopped: Data connection interrupted (STOP_BC_DATA_CONNECTION_INTERRUPTED)');
      break;
    case 15:
      console.log('RTMS stopped: Signaling connection closed abnormally (STOP_BC_SIGNAL_CONNECTION_CLOSED_ABNORMALLY)');
      break;
    case 16:
      console.log('RTMS stopped: Data connection closed abnormally (STOP_BC_DATA_CONNECTION_CLOSED_ABNORMALLY)');
      break;
    case 17:
      console.log('RTMS stopped: Received exit signal (STOP_BC_EXIT_SIGNAL)');
      break;
    case 18:
      console.log('RTMS stopped: Authentication failure (STOP_BC_AUTHENTICATION_FAILURE)');
      break;
    default:
      console.log(`RTMS stopped: Unknown reason code (${errorCode})`);
  }
}

export function logRtmsStatusCode(statusCode) {
  switch (statusCode) {
    case 0:
      console.log('RTMS status: OK');
      break;
    case 1:
      console.log('RTMS status: CONNECTION_TIMEOUT');
      break;
    case 2:
      console.log('RTMS status: INVALID_JSON_MSG_SIZE');
      break;
    case 3:
      console.log('RTMS status: INVALID_JSON_MSG');
      break;
    case 4:
      console.log('RTMS status: INVALID_MESSAGE_TYPE');
      break;
    case 5:
      console.log('RTMS status: MSG_TYPE_NOT_EXIST');
      break;
    case 6:
      console.log('RTMS status: MSG_TYPE_NOT_UINT');
      break;
    case 7:
      console.log('RTMS status: MEETING_UUID_NOT_EXIST');
      break;
    case 8:
      console.log('RTMS status: MEETING_UUID_NOT_STRING');
      break;
    case 9:
      console.log('RTMS status: MEETING_UUID_IS_EMPTY');
      break;
    case 10:
      console.log('RTMS status: RTMS_STREAM_ID_NOT_EXIST');
      break;
    case 11:
      console.log('RTMS status: RTMS_STREAM_ID_NOT_STRING');
      break;
    case 12:
      console.log('RTMS status: RTMS_STREAM_ID_IS_EMPTY');
      break;
    case 13:
      console.log('RTMS status: SESSION_NOT_FOUND');
      break;
    case 14:
      console.log('RTMS status: SIGNATURE_NOT_EXIST');
      break;
    case 15:
      console.log('RTMS status: INVALID_SIGNATURE');
      break;
    case 16:
      console.log('RTMS status: INVALID_MEETING_OR_STREAM_ID');
      break;
    case 17:
      console.log('RTMS status: DUPLICATE_SIGNAL_REQUEST');
      break;
    case 18:
      console.log('RTMS status: EVENTS_NOT_EXIST');
      break;
    case 19:
      console.log('RTMS status: EVENTS_VALUE_NOT_ARRAY');
      break;
    case 20:
      console.log('RTMS status: EVENT_TYPE_NOT_EXIST');
      break;
    case 21:
      console.log('RTMS status: EVENT_TYPE_VALUE_NOT_UINT');
      break;
    case 22:
      console.log('RTMS status: MEDIA_TYPE_NOT_EXIST');
      break;
    case 23:
      console.log('RTMS status: MEDIA_TYPE_NOT_UINT');
      break;
    case 24:
      console.log('RTMS status: MEDIA_TYPE_AUDIO_NOT_SUPPORT');
      break;
    case 25:
      console.log('RTMS status: MEDIA_TYPE_VIDEO_NOT_SUPPORT');
      break;
    case 26:
      console.log('RTMS status: MEDIA_TYPE_DESKSHARE_NOT_SUPPORT');
      break;
    case 27:
      console.log('RTMS status: MEDIA_TYPE_TRANSCRIPT_NOT_SUPPORT');
      break;
    case 28:
      console.log('RTMS status: MEDIA_TYPE_CHAT_NOT_SUPPORT');
      break;
    case 29:
      console.log('RTMS status: MEDIA_TYPE_INVALID_VALUE');
      break;
    case 30:
      console.log('RTMS status: MEDIA_DATA_ALL_CONNECTION_EXIST');
      break;
    case 31:
      console.log('RTMS status: DUPLICATE_MEDIA_DATA_CONNECTION');
      break;
    case 32:
      console.log('RTMS status: MEDIA_PARAMS_NOT_EXIST');
      break;
    case 33:
      console.log('RTMS status: INVALID_MEDIA_PARAMS');
      break;
    case 34:
      console.log('RTMS status: NO_MEDIA_TYPE_SPECIFIED');
      break;
    case 35:
      console.log('RTMS status: INVALID_MEDIA_AUDIO_PARAMS');
      break;
    case 36:
      console.log('RTMS status: MEDIA_AUDIO_CONTENT_TYPE_NOT_UINT');
      break;
    case 37:
      console.log('RTMS status: INVALID_MEDIA_AUDIO_CONTENT_TYPE');
      break;
    case 38:
      console.log('RTMS status: MEDIA_AUDIO_SAMPLE_RATE_NOT_UINT');
      break;
    case 39:
      console.log('RTMS status: INVALID_MEDIA_AUDIO_SAMPLE_RATE');
      break;
    case 40:
      console.log('RTMS status: MEDIA_AUDIO_CHANNEL_NOT_UINT');
      break;
    case 41:
      console.log('RTMS status: INVALID_MEDIA_AUDIO_CHANNEL');
      break;
    case 42:
      console.log('RTMS status: MEDIA_AUDIO_CODEC_NOT_UINT');
      break;
    case 43:
      console.log('RTMS status: INVALID_MEDIA_AUDIO_CODEC');
      break;
    case 44:
      console.log('RTMS status: MEDIA_AUDIO_DATA_OPT_NOT_UINT');
      break;
    case 45:
      console.log('RTMS status: INVALID_MEDIA_AUDIO_DATA_OPT');
      break;
    case 46:
      console.log('RTMS status: MEDIA_AUDIO_SEND_RATE_NOT_UINT');
      break;
    case 47:
      console.log('RTMS status: MEDIA_AUDIO_FRAME_SIZE_NOT_UINT');
      break;
    case 48:
      console.log('RTMS status: INVALID_MEDIA_VIDEO_PARAMS');
      break;
    case 49:
      console.log('RTMS status: INVALID_MEDIA_VIDEO_CONTENT_TYPE');
      break;
    case 50:
      console.log('RTMS status: MEDIA_VIDEO_CONTENT_TYPE_NOT_UINT');
      break;
    case 51:
      console.log('RTMS status: INVALID_MEDIA_VIDEO_CODEC');
      break;
    case 52:
      console.log('RTMS status: MEDIA_VIDEO_CODEC_NOT_UINT');
      break;
    case 53:
      console.log('RTMS status: INVALID_MEDIA_VIDEO_RESOLUTION');
      break;
    case 54:
      console.log('RTMS status: MEDIA_VIDEO_RESOLUTION_NOT_UINT');
      break;
    case 55:
      console.log('RTMS status: INVALID_MEDIA_VIDEO_DATA_OPT');
      break;
    case 56:
      console.log('RTMS status: MEDIA_VIDEO_DATA_OPT_NOT_UINT');
      break;
    case 57:
      console.log('RTMS status: MEDIA_VIDEO_FPS_NOT_UINT');
      break;
    case 58:
      console.log('RTMS status: INVALID_MEDIA_SHARE_PARAMS');
      break;
    case 59:
      console.log('RTMS status: INVALID_AUDIO_DATA_BUFFER');
      break;
    case 60:
      console.log('RTMS status: INVALID_VIDEO_DATA_BUFFER');
      break;
    case 61:
      console.log('RTMS status: POST_FIRST_PACKET_FAILURE');
      break;
    case 62:
      console.log('RTMS status: RTMS_SESSION_NOT_FOUND');
      break;
    default:
      console.log(`RTMS status: Unknown status code (${statusCode})`);
  }
}


