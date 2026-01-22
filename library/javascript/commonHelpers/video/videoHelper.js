import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { UUIDHelper } from '../filename/UUIDHelper.js';

export { H264StreamAnalyzer } from './H264StreamAnalyzer.js';

const execAsync = promisify(exec);

// Cache for open write streams
const videoWriteStreams = new Map();

/**
 * Sanitizes a UUID by replacing non-alphanumeric characters with underscores.
 */
function sanitize(uuid) {
    return UUIDHelper.sanitize(uuid);
}

/**
 * Saves raw H.264 video frames to disk.
 */
export function saveRawVideo(buffer, userId, timestamp, meetingUuid, streamId, isMixed = true) {
    const safeUserId = userId ? sanitize(userId) : 'default-view';
    const safeMeetingUuid = sanitize(meetingUuid);
    const safeStreamId = sanitize(streamId);
    const outputDir = path.join(process.cwd(), 'recordings', safeMeetingUuid, safeStreamId);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const fileName = isMixed ? 'mixed_video.h264' : `${safeUserId}.h264`;
    const filePath = path.join(outputDir, fileName);

    let writeStream = videoWriteStreams.get(filePath);
    if (!writeStream) {
        writeStream = fs.createWriteStream(filePath, { flags: 'a' });
        videoWriteStreams.set(filePath, writeStream);
    }

    writeStream.write(buffer);
}

/**
 * Converts a raw H264 file to MP4 format using FFmpeg.
 */
export async function convertH264ToMp4(inputFile, outputFile, options = {}) {
    const fps = options.fps || 25;
    const command = `ffmpeg -y -framerate ${fps} -probesize 50M -analyzeduration 50M -i "${inputFile}" -c:v copy "${outputFile}"`;
    
    try {
        await execAsync(command);
    } catch (error) {
        throw new Error(`FFmpeg video conversion failed: ${error.message}`);
    }
}

/**
 * Combines multiple video files into a grid layout.
 */
export async function createVideoGrid(inputFiles, outputFile) {
    if (inputFiles.length < 2) return;
    const count = inputFiles.length;
    const inputs = inputFiles.map(f => `-i "${f}"`).join(' ');
    const cols = Math.ceil(Math.sqrt(count));
    
    let layout = '';
    for (let i = 0; i < count; i++) {
        const r = Math.floor(i / cols);
        const c = i % cols;
        layout += (i > 0 ? '|' : '') + (c === 0 ? '0' : Array.from({length:c}, (_,k)=>`w${k}`).join('+')) + '_' + (r === 0 ? '0' : Array.from({length:r}, (_,k)=>`h${k*cols}`).join('+'));
    }
    
    const filterComplex = `xstack=inputs=${count}:layout=${layout}[v]`;
    const command = `ffmpeg -y ${inputs} -filter_complex "${filterComplex}" -map "[v]" -c:v libx264 -preset veryfast "${outputFile}"`;
    
    try {
        await execAsync(command);
    } catch (error) {
        throw new Error(`FFmpeg video grid creation failed: ${error.message}`);
    }
}

export function closeAllVideoStreams() {
    for (const stream of videoWriteStreams.values()) {
        stream.end();
    }
    videoWriteStreams.clear();
}
