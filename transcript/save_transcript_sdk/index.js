

import { writeTranscriptToVtt } from './writeTranscriptToVtt.js';

// Load secrets from .env
import dotenv from 'dotenv';
dotenv.config();
// Import the RTMS SDK
import rtms from "@zoom/rtms";

function setVideoParamsCompat(client, params) {
    if (typeof client.setVideoParams === "function") return client.setVideoParams(params);
    if (typeof client.setVideoParameters === "function") return client.setVideoParameters(params);
    throw new Error("RTMS SDK client missing setVideoParams/setVideoParameters");
}

let meetingUUID;

// Set up webhook event handler to receive RTMS events from Zoom
rtms.onWebhookEvent(({ event, payload }) => {
    console.log(`Received webhook event: ${event}`);

    if (event === "meeting.rtms_started") {
        meetingUUID = payload.meeting_uuid;
    } else if (event === "meeting.rtms_stopped") {
        return;
    } else {
        return;
    }

    // Create a client instance for this specific meeting
    const client = new rtms.Client();


    // client.setAudioParameters({

    //     codec: rtms.AudioCodec.L16,
    //     /** The sample rate in Hz (e.g., 8000, 16000, 44100) */
    //     sampleRate:  rtms.AudioSampleRate.SR_16K,
    //     /** The number of audio channels (1=mono, 2=stereo) */
    //     channel:  rtms.AudioChannel.MONO,
    //     /** Additional data options for audio processing */
    //     dataOpt:  rtms.AudioDataOption.AUDIO_MULTI_STREAMS,
    //     /** The duration of each audio frame in milliseconds */
    //     duration: 100,
    //     /** The size of each audio frame in samples */
    //     frameSize:640


    // });



    // Configure HD video (720p H.264 at 30fps)
    setVideoParamsCompat(client, {
        contentType: rtms.VideoContentType.RAW_VIDEO,
        codec: rtms.VideoCodec.H264,
        resolution: rtms.VideoResolution.HD,
        dataOpt: rtms.VideoDataOption.VIDEO_SINGLE_ACTIVE_STREAM,
        fps: 25
    });

    // Set up video data handler
    client.onVideoData((data, size, timestamp, metadata) => {
       // console.log(`Video data: ${size} bytes from ${metadata.userName}`);
    });


    // Set up audio data handler
    client.onAudioData((data, size, timestamp, metadata) => {
       // console.log(`Audio data: ${size} bytes from ${metadata.userName}`);
    });


    // Set up transcript data handler
    client.onTranscriptData((data, size, timestamp, metadata) => {
        console.log(`${metadata.userName}: ${data}`);
     
        writeTranscriptToVtt(metadata.userName, timestamp / 1000, data, meetingUUID);

    });

    // Join the meeting using the webhook payload directly
    client.join(payload);
});
