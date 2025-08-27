

process.env.GST_DEBUG = "2";
process.env.GST_DEBUG_FILE = "/tmp/gstreamer.log";
console.log("GStreamer debug logging enabled.");


const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const gstreamer = require('gstreamer-superficial');
const dotenv = require('dotenv');
const fs = require('fs');
dotenv.config();

let ffmpegProcess;
let audioStream = new PassThrough();
let videoStream = new PassThrough();
let muxedStream = new PassThrough();

function deleteFileIfExists(filePath) {
    if (fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
            console.log(`File ${filePath} found and deleted.`);
        } catch (err) {
            console.error(`Error deleting file ${filePath}:`, err);
        }
    } else {
        console.log(`File ${filePath} does not exist.`);
    }
}

function startFFmpeg() {

    deleteFileIfExists("output.mp4");

    ffmpegProcess = spawn('ffmpeg', [
        '-nostdin',
        '-loglevel', 'error',

        // Generate PTS when inputs are raw/live
        '-fflags', '+genpts',

        // ---- AUDIO INPUT (pipe:3) ----
        '-thread_queue_size', '4096',
        '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:3',

        // ---- VIDEO INPUT (pipe:4) ----
        // IMPORTANT: use -r as an *input* option for raw H.264
        '-thread_queue_size', '4096',
        '-r', '25', '-f', 'h264', '-i', 'pipe:4',

        // ---- Encoding (shared) ----
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
        '-g', '25', '-keyint_min', '25',
        '-force_key_frames', 'expr:gte(t,n_forced*1)',
        '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '1',

        // ---- OUTPUT #1: MPEG-TS to stdout (for GStreamer) ----
        // Map video from input #1 and audio from input #0
        '-map', '1:v:0', '-map', '0:a:0',
        '-f', 'mpegts', 'pipe:1',

        // ---- OUTPUT #2: MP4 to file ----
        // Map again for the second output (mapping is per-output)
        '-map', '1:v:0', '-map', '0:a:0',
        '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+faststart',
        './output.mp4'
    ], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });

    ffmpegProcess.stdout.on('data', (data) => {
        const ok = muxedStream.write(data);
        if (!ok) ffmpegProcess.stdout.pause();
    });
    muxedStream.on('drain', () => ffmpegProcess.stdout.resume());



    ffmpegProcess.stderr.on('data', (data) => {
        console.error('[FFmpeg Error]:', data.toString());
    });

    ffmpegProcess.on('close', (code) => {
        console.log(`[FFmpeg] Process closed with code: ${code}`);
        startFFmpeg(); // Restart if needed
    });

    console.log('[FFmpeg] Started successfully.');
}

// Start the FFmpeg process
startFFmpeg();



const pipelineDesc = `
appsrc name=src is-live=true do-timestamp=true format=time \
  caps=video/mpegts,systemstream=true,packetsize=188 !
tsdemux name=demux

  demux. ! queue ! h264parse config-interval=-1 !
    video/x-h264,stream-format=avc,alignment=au !
    kvssink name=ks stream-name=${process.env.STREAM_NAME} aws-region=${process.env.AWS_REGION} \
      access-key=${process.env.AWS_ACCESS_KEY_ID} secret-key=${process.env.AWS_SECRET_ACCESS_KEY}

  demux. ! queue ! aacparse !
    audio/mpeg, mpegversion=4, stream-format=raw !
    ks.
`;


let gstreamerPipeline;
let appsrc;

try {
    gstreamerPipeline = new gstreamer.Pipeline(pipelineDesc);
    appsrc = gstreamerPipeline.findChild('src');
    console.log("[GStreamer] Pipeline and appsrc initialized.");
    gstreamerPipeline.play();
} catch (error) {
    console.error("[GStreamer] Pipeline initialization failed:", error);
}





// function sendVideoBuffer(buffer, timestamp) {
//     try {
//         // Directly use timestamp in milliseconds, clamped to the valid range
//         const pts = BigInt(timestamp) % BigInt(4294967296);  // Clamp to 32-bit range
//         const header = Buffer.alloc(8);
//         header.writeUInt32BE(Number((pts >> BigInt(32)) & BigInt(0xFFFFFFFF)), 0);  // Upper 32 bits
//         header.writeUInt32BE(Number(pts & BigInt(0xFFFFFFFF)), 4);  // Lower 32 bits

//         const videoPacket = Buffer.concat([header, buffer]);
//         videoStream.write(videoPacket);
//         ffmpegProcess.stdio[4].write(videoPacket);  // Write video with timestamp to FFmpeg pipe
//         //console.log(`[Video] Sent video buffer of size: ${buffer.length} with PTS: ${pts}`);
//     } catch (err) {
//         console.error('[Video] Error writing to FFmpeg:', err);
//     }
// }

// function sendAudioBuffer(buffer, timestamp) {
//     try {
//         // Directly use timestamp in milliseconds, clamped to the valid range
//         const pts = BigInt(timestamp) % BigInt(4294967296);  // Clamp to 32-bit range
//         const header = Buffer.alloc(8);
//         header.writeUInt32BE(Number((pts >> BigInt(32)) & BigInt(0xFFFFFFFF)), 0);  // Upper 32 bits
//         header.writeUInt32BE(Number(pts & BigInt(0xFFFFFFFF)), 4);  // Lower 32 bits

//         const audioPacket = Buffer.concat([header, buffer]);
//         audioStream.write(audioPacket);
//         ffmpegProcess.stdio[3].write(audioPacket);  // Write audio with timestamp to FFmpeg pipe
//         ///console.log(`[Audio] Sent audio buffer of size: ${buffer.length} with PTS: ${pts}`);
//     } catch (err) {
//         console.error('[Audio] Error writing to FFmpeg:', err);
//     }
// }
// Capture merged data from FFmpeg and send to GStreamer
function sendVideoBuffer(buffer, timestamp) {
    try {

        //videoStream.write(buffer);
        ffmpegProcess.stdio[4].write(buffer);
    } catch (err) {
        console.error('[Video] Error writing to FFmpeg:', err);
    }
}

function sendAudioBuffer(buffer, timestamp) {
    try {
        //audioStream.write(buffer);
        ffmpegProcess.stdio[3].write(buffer);
    } catch (err) {
        console.error('[Audio] Error writing to FFmpeg:', err);
    }
}



muxedStream.on('data', (chunk) => {
    try {
        if (appsrc) {
            appsrc.push(chunk);
            //console.log(`[GStreamer] Sent merged chunk of size: ${chunk.length}`);
        } else {
            console.error('[GStreamer] appsrc element not found.');
        }
    } catch (err) {
        console.error('[GStreamer] Error sending merged chunk:', err);
    }
});

function startStream() { }

module.exports = { startStream, sendAudioBuffer, sendVideoBuffer };