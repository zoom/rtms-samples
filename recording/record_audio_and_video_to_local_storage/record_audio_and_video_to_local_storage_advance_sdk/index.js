import { saveRawAudio } from './saveRawAudioAdvance.js';
import { saveRawVideo } from './saveRawVideoAdvance.js';
import { convertMeetingMedia } from './convertMeetingMedia.js';
import { muxFirstAudioVideo } from './muxFirstAudioVideo.js';


let meetingUuid;

// Load secrets from .env
import dotenv from 'dotenv';
dotenv.config();
// Import the RTMS SDK
import rtms from "@zoom/rtms";

// Set up webhook event handler to receive RTMS events from Zoom
rtms.onWebhookEvent(async ({ event, payload }) => {
    console.log(`Received webhook event: ${event}`);

    // Only process webhook events for RTMS start notifications
    if (event == "meeting.rtms_started") {
        console.log(`Received event ${event}, ignoring...`);
        meetingUuid = payload.meeting_uuid;
    }
    if (event == "meeting.rtms_stopped") {
        console.log(`Received event ${event}, ignoring...`);
        let _meeting_uuid = payload.meeting_uuid;

        await convertMeetingMedia(_meeting_uuid);
        await muxFirstAudioVideo(_meeting_uuid);
      return;
    }
    // Create a client instance for this specific meeting
    const client = new rtms.Client();


    client.setAudioParams({
        contentType: rtms.AudioContentType.RAW_AUDIO,
        codec: rtms.AudioCodec.L16,
        sampleRate:  rtms.AudioSampleRate.SR_16K,
        channel:  rtms.AudioChannel.MONO,
        dataOpt:  rtms.AudioDataOption.AUDIO_MIXED_STREAM,
        duration: 100
    });

    // Configure HD video (720p H.264 at 30fps)
    client.setVideoParams({
        contentType: rtms.VideoContentType.RAW_VIDEO,
        codec: rtms.VideoCodec.H264,
        resolution: rtms.VideoResolution.HD,
        dataOpt: rtms.VideoDataOption.VIDEO_SINGLE_ACTIVE_STREAM,
        fps: 25
    });

    // Set up video data handler
    client.onVideoData((data, size, timestamp, metadata) => {
        //console.log(`Video data: ${size} bytes from ${metadata.userName}`);
        let epochMilliseconds = Date.now();
        let buffer = Buffer.from(data, 'base64');
        saveRawVideo(buffer, metadata.userName, epochMilliseconds, meetingUuid);
    });


    // Set up audio data handler
    client.onAudioData((data, size, timestamp, metadata) => {
        //console.log(`Audio data: ${size} bytes from ${metadata.userName}`);

        let epochMilliseconds = Date.now();
        if (metadata.userId == null || !meetingUuid) {
            console.error('Missing metadata: cannot save audio');
            return;
        }
        //console.log(meetingUuid+metadata.userId+epochMilliseconds);
        let buffer = Buffer.from(data, 'base64');
        saveRawAudio(buffer, meetingUuid, metadata.userId, epochMilliseconds);
    });


    // Set up transcript data handler
    client.onTranscriptData((data, size, timestamp, metadata) => {
        console.log(`${metadata.userName}: ${data}`);
    });

    // Join the meeting using the webhook payload directly
    client.join(payload);
});