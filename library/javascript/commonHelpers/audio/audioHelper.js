import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { UUIDHelper } from '../filename/UUIDHelper.js';

const execAsync = promisify(exec);

// Cache for open write streams
const writeStreams = new Map();

/**
 * Sanitizes a UUID by replacing non-alphanumeric characters with underscores.
 */
function sanitize(uuid) {
    return UUIDHelper.sanitize(uuid);
}

/**
 * Analyzes raw PCM audio data (e.g., calculating volume levels).
 */
export class PCMAnalyzer {
    constructor(options = {}) {
        this.sampleRate = options.sampleRate || 16000;
        this.bitDepth = options.bitDepth || 16;
        this.channels = options.channels || 1;
    }

    analyze(buffer) {
        // Basic volume analysis (RMS)
        let sum = 0;
        for (let i = 0; i < buffer.length; i += 2) {
            const sample = buffer.readInt16LE(i);
            sum += sample * sample;
        }
        const rms = Math.sqrt(sum / (buffer.length / 2));
        const db = 20 * Math.log10(rms / 32768);
        if (db > -60) {
            console.log(`[PCMAnalyzer] 🔊 Volume: ${db.toFixed(2)} dB`);
        }
    }
}

/**
 * Saves raw PCM audio chunks to disk.
 */
export function saveRawAudio(chunk, meetingUuid, user_id, timestamp, streamId, isMixed = true) {
    const safeMeetingUuid = sanitize(meetingUuid);
    const safeStreamId = sanitize(streamId);
    const fileName = isMixed ? 'mixed_audio.raw' : `${user_id}.raw`;
    const filePath = path.join(process.cwd(), 'recordings', safeMeetingUuid, safeStreamId, fileName);

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    let stream = writeStreams.get(filePath);
    if (!stream) {
        stream = fs.createWriteStream(filePath, { flags: 'a' });
        writeStreams.set(filePath, stream);
    }

    stream.write(chunk);
}

/**
 * Converts a raw audio file to WAV format using FFmpeg.
 */
export async function convertRawToWav(inputFile, outputFile, options = {}) {
    const sampleRate = options.sampleRate || 16000;
    const channels = options.channels || 1;
    const command = `ffmpeg -y -f s16le -ar ${sampleRate} -ac ${channels} -i "${inputFile}" "${outputFile}"`;
    
    try {
        await execAsync(command);
    } catch (error) {
        throw new Error(`FFmpeg audio conversion failed: ${error.message}`);
    }
}

/**
 * Merges multiple audio files into a single mixed WAV file.
 */
export async function mergeAudioFiles(inputFiles, outputFile) {
    if (inputFiles.length < 2) return;
    const inputs = inputFiles.map(f => `-i "${f}"`).join(' ');
    const command = `ffmpeg -y ${inputs} -filter_complex amix=inputs=${inputFiles.length}:duration=longest "${outputFile}"`;
    
    try {
        await execAsync(command);
    } catch (error) {
        throw new Error(`FFmpeg audio merge failed: ${error.message}`);
    }
}

export function closeAllAudioStreams() {
    for (const stream of writeStreams.values()) {
        stream.end();
    }
    writeStreams.clear();
}
