// Import necessary libraries
import express from 'express';



import { startLocalTranscoding } from './localTranscodedStreamer.js';

// Load environment variables from a .env file


const app = express();


// Middleware to parse JSON bodies in incoming requests
app.use(express.json());

// 🆕 Serve the static files from the /public folder
app.use(express.static('public'));

// 🆕 CORS headers for HLS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});


// 🆕 Route to serve the player page
app.get('/player', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Live Stream</title>
        </head>
        <body>
            <h2>Live Stream</h2>
            <video id="videoPlayer" width="720" height="480" controls autoplay></video>

            <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
            <script>
                if (Hls.isSupported()) {
                    var video = document.getElementById('videoPlayer');
                    var hls = new Hls();
                    hls.loadSource('/hls/stream.m3u8');
                    hls.attachMedia(video);
                    hls.on(Hls.Events.MANIFEST_PARSED, function () {
                        video.play();
                    });
                } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                    video.src = '/hls/stream.m3u8';
                    video.addEventListener('loadedmetadata', function () {
                        video.play();
                    });
                } else {
                    alert('Your browser does not support HLS playback.');
                }
            </script>
        </body>
        </html>
    `);
});

app.listen(6060, (err) => {
    if (err) {
        console.error('Failed to start server:', err);
    } else {
        console.log('Server running on port 6060');
    }
});

// Load secrets from .env
import dotenv from 'dotenv';
dotenv.config();
// Import the RTMS SDK
import rtms from "@zoom/rtms";


// Start live transcoding and get streams
const { videoStream, audioStream, ffmpeg } = startLocalTranscoding();

// Set up webhook event handler to receive RTMS events from Zoom
rtms.onWebhookEvent(({ event, payload }) => {
    console.log(`Received webhook event: ${event}`);

    // Only process webhook events for RTMS start notifications
    if (event !== "meeting.rtms_started") {
        console.log(`Received event ${event}, ignoring...`);
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
    client.setVideoParameters({
        contentType: rtms.VideoContentType.RAW_VIDEO,
        codec: rtms.VideoCodec.H264,
        resolution: rtms.VideoResolution.HD,
        dataOpt: rtms.VideoDataOption.VIDEO_SINGLE_ACTIVE_STREAM,
        fps: 25
    });

    // Set up video data handler
    client.onVideoData((data, size, timestamp, metadata) => {
        //console.log(`Video data: ${size} bytes from ${metadata.userName}`);
        const buffer = Buffer.from(data, 'base64');

        if (videoStream.writable) {
            videoStream.write(buffer);
        } else {
            console.warn('⚠️ Video stream not writable');
        }
    });


    // Set up audio data handler
    client.onAudioData((data, size, timestamp, metadata) => {
        // console.log(`Audio data: ${size} bytes from ${metadata.userName}`);
        const buffer = Buffer.from(data, 'base64');
        if (audioStream.writable) {
            audioStream.write(buffer);
        } else {
            console.warn('⚠️ Audio stream not writable');
        }
    });


    // Set up transcript data handler
    client.onTranscriptData((data, size, timestamp, metadata) => {
        console.log(`${metadata.userName}: ${data}`);
    });

    // Join the meeting using the webhook payload directly
    client.join(payload);



});


