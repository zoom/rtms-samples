
import dotenv from 'dotenv';
dotenv.config();

import { azureSpeechToTextStream } from "./azureSpeechToText.js";

// Imnod in the RTMS SDK
import rtms from "@zoom/rtms";
import { startAuthenticatedWebhookServer } from './authenticatedWebhookServer.js';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';

function setAudioParamsCompat(client, params) {
  if (typeof client.setAudioParams === "function") return client.setAudioParams(params);
  if (typeof client.setAudioParameters === "function") return client.setAudioParameters(params);
  throw new Error("RTMS SDK client missing setAudioParams/setAudioParameters");
}

function setVideoParamsCompat(client, params) {
  if (typeof client.setVideoParams === "function") return client.setVideoParams(params);
  if (typeof client.setVideoParameters === "function") return client.setVideoParameters(params);
  throw new Error("RTMS SDK client missing setVideoParams/setVideoParameters");
}

const clients = new Set();
const webhookServer = startAuthenticatedWebhookServer(({ event, payload }) => {
  console.log(`Received webhook event: ${event}`);

  // Only process webhook events for RTMS start notifications
  if (event !== "meeting.rtms_started") {
    console.log(`Received event ${event}, ignoring...`);
    return;
  }

  
  // Create a client instance for this specific meeting
  const client = new rtms.Client();
  clients.add(client);
  

  // Configure HD video (720p H.264 at 25fps)
  setVideoParamsCompat(client, {
    contentType: rtms.VideoContentType.RAW_VIDEO,
    codec: rtms.VideoCodec.H264,
    resolution: rtms.VideoResolution.HD,
    dataOpt: rtms.VideoDataOption.VIDEO_SINGLE_ACTIVE_STREAM,
    fps: 25
  });

  setAudioParamsCompat(client, {
    contentType: rtms.AudioContentType.RAW_AUDIO,
    sampleRate: rtms.AudioSampleRate.SR_16K,
    channel: rtms.AudioChannel.MONO,
    codec: rtms.AudioCodec.L16,
    dataOpt: rtms.AudioDataOption.AUDIO_MIXED_STREAM,
    duration: 100
  });

  // Set up video data handler
  client.onVideoData((data, size, timestamp, metadata) => {
    //console.log(`Video data: ${size} bytes from ${metadata.userName}`);
  });
    

  // Set up audio data handler
  client.onAudioData((data, size, timestamp, metadata) => {
    //console.log(`Audio data: ${size} bytes from ${metadata.userName}`);

    let buffer = Buffer.from(data, 'base64');
    azureSpeechToTextStream(buffer);
  }); 


  // Set up transcript data handler
  client.onTranscriptData((data, size, timestamp, metadata) => {
    console.log(`${metadata.userName}: ${data}`);
  });

  // Join the meeting using the webhook payload directly
  client.join(payload);
});

installGracefulShutdown({ name: 'Azure Speech SDK', cleanup: async () => {
  await closeHttpServer(webhookServer);
  await Promise.allSettled([...clients].map((client) => Promise.resolve(client.leave())));
  clients.clear();
} });
