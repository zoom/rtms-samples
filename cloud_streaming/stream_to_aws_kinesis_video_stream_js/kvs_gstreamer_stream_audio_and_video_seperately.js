process.env.GST_DEBUG = "kvssink:4,*aac*:3,*voaacenc*:3,appsrc:3";

process.env.GST_DEBUG_FILE = "/tmp/gstreamer.log";
console.log("GStreamer debug logging enabled.");


const { PassThrough } = require('stream');
const gstreamer = require('gstreamer-superficial');
const dotenv = require('dotenv');
dotenv.config();

let videoPipeline, audioPipeline;
let videoAppsrc, audioAppsrc;

const videoPipelineDesc = `
    appsrc name=videosrc is-live=true do-timestamp=true format=time !
    h264parse ! video/x-h264,stream-format=avc,alignment=au !
    kvssink stream-name=${process.env.STREAM_NAME} aws-region=${process.env.AWS_REGION}
    access-key=${process.env.AWS_ACCESS_KEY_ID} secret-key=${process.env.AWS_SECRET_ACCESS_KEY}
`;




const audioPipelineDesc = `
    appsrc name=audiosrc is-live=true do-timestamp=true format=time 
    caps=audio/x-raw,format=S16LE,rate=16000,channels=1,layout=interleaved !
    audioconvert ! audioresample ! voaacenc bitrate=64000 !
    aacparse ! audio/mpeg,mpegversion=4,stream-format=raw !
    kvssink stream-name=${process.env.STREAM_NAME2} aws-region=${process.env.AWS_REGION}
    access-key=${process.env.AWS_ACCESS_KEY_ID} secret-key=${process.env.AWS_SECRET_ACCESS_KEY}
`;


try {
    videoPipeline = new gstreamer.Pipeline(videoPipelineDesc);
    videoAppsrc = videoPipeline.findChild('videosrc');
    videoPipeline.play();
    console.log("[GStreamer] Video pipeline started.");
} catch (error) {
    console.error("[GStreamer] Failed to start video pipeline:", error);
}

try {
    audioPipeline = new gstreamer.Pipeline(audioPipelineDesc);
    audioAppsrc = audioPipeline.findChild('audiosrc');
    audioPipeline.play();
    console.log("[GStreamer] Audio pipeline started.");
} catch (error) {
    console.error("[GStreamer] Failed to start audio pipeline:", error);
}

// Send video buffer to video KVS stream
function sendVideoBuffer(buffer) {
    try {
        if (videoAppsrc) {
            videoAppsrc.push(buffer);
        } else {
            console.error('[Video] Video appsrc not initialized.');
        }
    } catch (err) {
        console.error('[Video] Error writing to GStreamer video pipeline:', err);
    }
}

// Send audio buffer to audio KVS stream
function sendAudioBuffer(buffer) {
    try {
        if (audioAppsrc) {
            console.log(`[Audio] Sending PCM buffer of size: ${buffer.length}`);
            audioAppsrc.push(buffer);
        } else {
            console.error('[Audio] Audio appsrc not initialized.');
        }
    } catch (err) {
        console.error('[Audio] Error writing to GStreamer audio pipeline:', err);
    }
}


// Optional entry point
function startStream() {
    console.log("Streaming started. Awaiting buffers...");
}

module.exports = {
    startStream,
    sendVideoBuffer,
    sendAudioBuffer
};

