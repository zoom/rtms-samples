import HelperManager, { VideoGapFiller } from '../../library/javascript/commonHelpers/HelperManager.js';
import dotenv from 'dotenv';
import rtms from "@zoom/rtms";

dotenv.config();

const meetingState = new Map();

rtms.onWebhookEvent(async ({ event, payload }) => {
    console.log(`Received webhook event: ${event}`);

    if (event === "meeting.rtms_started") {
        const meetingUuid = payload.meeting_uuid;
        const streamId = payload.rtms_stream_id;
        console.log(`[SDK] RTMS started for meeting ${meetingUuid}`);

        const videoFiller = new VideoGapFiller({ fps: 25, gapThreshold: 320 });
        
        videoFiller.on('data', ({ buffer, timestamp, isFiller }) => {
            HelperManager.video.saveRawVideo(buffer, 'mixed', timestamp, meetingUuid, streamId, true);
        });
        
        videoFiller.start();
        meetingState.set(meetingUuid, { videoFiller, streamId });
    }

    if (event === "meeting.rtms_stopped") {
        const meetingUuid = payload.meeting_uuid;
        const streamId = payload.rtms_stream_id;
        console.log(`[SDK] RTMS stopped for meeting ${meetingUuid}`);

        const state = meetingState.get(meetingUuid);
        if (state) {
            state.videoFiller.stop();
            meetingState.delete(meetingUuid);
        }

        setTimeout(async () => {
            await HelperManager.audiovideo.convertMeetingMedia(meetingUuid, streamId);
            await HelperManager.audiovideo.muxMixedAudioVideo(meetingUuid, streamId);
        }, 2000);
        return;
    }

    const client = new rtms.Client();
    const meetingUuid = payload.meeting_uuid;
    const streamId = payload.rtms_stream_id;

    client.setVideoParams({
        contentType: rtms.VideoContentType.RAW_VIDEO,
        codec: rtms.VideoCodec.H264,
        resolution: rtms.VideoResolution.HD,
        dataOpt: rtms.VideoDataOption.VIDEO_SINGLE_ACTIVE_STREAM,
        fps: 25
    });

    client.onVideoData((data, size, timestamp, metadata) => {
        const buffer = Buffer.from(data, 'base64');
        const ts = Date.now();
        const state = meetingState.get(meetingUuid);
        if (state) {
            state.videoFiller.push(buffer, ts);
        }
    });

    client.onAudioData((data, size, timestamp, metadata) => {
        if (!meetingUuid) return;
        const buffer = Buffer.from(data, 'base64');
        const ts = Date.now();
        HelperManager.audio.saveRawAudio(buffer, meetingUuid, 'mixed', ts, streamId, true);
    });

    client.onTranscriptData((data, size, timestamp, metadata) => {
        console.log(`${metadata.userName}: ${data}`);
    });

    client.join(payload);
});
