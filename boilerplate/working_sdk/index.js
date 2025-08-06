
// Load secrets from .env
import dotenv from 'dotenv';
dotenv.config();
// Import the RTMS SDK
import rtms from "@zoom/rtms";

let clients = new Map();

// Set up webhook event handler to receive RTMS events from Zoom
rtms.onWebhookEvent(({ event, payload }) => {
  const streamId = payload?.rtms_stream_id;

  if (event == "meeting.rtms_stopped") {
    if (!streamId) {
      console.log(`Received meeting.rtms_stopped event without stream ID`);
      return;
    }

    const client = clients.get(streamId);
    if (!client) {
      console.log(`Received meeting.rtms_stopped event for unknown stream ID: ${streamId}`)
      return
    }

    client.leave();
    clients.delete(streamId);

    return;
  } else if (event !== "meeting.rtms_started") {
    console.log(`Ignoring unknown event`);
    return;
  }

  // Create a new RTMS client for the stream if it doesn't exist
  const client = new rtms.Client();
  clients.set(streamId, client);


  const audio_params = {
    contentType: rtms.AudioContentType.RAW_AUDIO,
    codec: rtms.AudioCodec.L16,
    channel: rtms.AudioChannel.MONO,
    dataOpt: rtms.AudioDataOption.AUDIO_MIXED_STREAM,
    duration: 100

  }
  client.setAudioParams(audio_params);


  // Configure HD video (720p H.264 at 30fps)
  const video_params = {
    contentType: rtms.VideoContentType.RAW_VIDEO,
    codec: rtms.VideoCodec.H264,
    resolution: rtms.VideoResolution.SD,
    dataOpt: rtms.VideoDataOption.VIDEO_SINGLE_ACTIVE_STREAM,
    fps: 30
  }

  client.setVideoParams(video_params);

  client.onVideoData((data, size, timestamp, metadata) => {
    console.log(`Video data: ${size} bytes from ${metadata.userName}`);
  });


  // // Configure HD video (720p H.264 at 30fps)
  // const deskshare_params = {
  //   contentType: rtms.VideoContentType.RAW_VIDEO,
  //   codec: rtms.VideoCodec.JPG,
  //   resolution: rtms.VideoResolution.SD,
  //   fps: 5
  // }

  // client.setDeskshareParams(deskshare_params)

  client.onDeskshareData((data, size, timestamp, metadata) => {
    console.log(`Received ${size} bytes of deskshare data at ${timestamp} from ${metadata.userName}`);
  });

  // Set up audio data handler
  client.onAudioData((data, size, timestamp, metadata) => {
    console.log(`Audio data: ${size} bytes from ${metadata.userName}`);
  });

  // Set up transcript data handler
  client.onTranscriptData((data, size, timestamp, metadata) => {
    console.log(`${metadata.userName}: ${data}`);
  });

  // Join the meeting using the webhook payload directly
  client.join(payload);
});