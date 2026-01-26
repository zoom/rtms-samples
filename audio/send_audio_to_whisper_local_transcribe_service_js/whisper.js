// whisper.js
// Local Whisper transcription module using OpenAI's Whisper model via Python subprocess

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';

dotenv.config();

//=============================================================================
// CONFIGURATION
//=============================================================================

const CONFIG = {
    // Whisper model settings
    MODEL: process.env.WHISPER_MODEL || 'tiny',
    LANGUAGE: process.env.WHISPER_LANGUAGE || 'en',
    
    // Audio settings (must match RTMS audio parameters)
    AUDIO: {
        SAMPLE_RATE: 16000,
        CHANNELS: 1,
        BYTES_PER_SAMPLE: 2, // 16-bit PCM
    },
    
    // Chunk settings
    CHUNK_DURATION_MS: parseInt(process.env.WHISPER_CHUNK_DURATION_MS) || 3000,
};

// Calculate target chunk size in bytes
const TARGET_CHUNK_SIZE = (CONFIG.AUDIO.SAMPLE_RATE * CONFIG.AUDIO.CHANNELS * CONFIG.AUDIO.BYTES_PER_SAMPLE * CONFIG.CHUNK_DURATION_MS) / 1000;

// State management
let audioBuffer = [];
let totalBufferedBytes = 0;
let isProcessing = false;
let chunkCounter = 0;
let processQueue = [];

console.log('[Whisper] Local Transcription Service Initialized');
console.log(`   Model: ${CONFIG.MODEL}`);
console.log(`   Language: ${CONFIG.LANGUAGE || 'auto-detect'}`);
console.log(`   Chunk Duration: ${CONFIG.CHUNK_DURATION_MS}ms`);
console.log(`   Target Chunk Size: ${TARGET_CHUNK_SIZE} bytes`);

//=============================================================================
// WAV FILE UTILITIES
//=============================================================================

/**
 * Creates a WAV file header for PCM audio
 * @param {number} dataLength - Length of audio data in bytes
 * @returns {Buffer} - WAV header buffer
 */
function createWavHeader(dataLength) {
    const header = Buffer.alloc(44);
    
    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4); // File size - 8
    header.write('WAVE', 8);
    
    // fmt subchunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // Subchunk1 size (16 for PCM)
    header.writeUInt16LE(1, 20); // Audio format (1 = PCM)
    header.writeUInt16LE(CONFIG.AUDIO.CHANNELS, 22); // Number of channels
    header.writeUInt32LE(CONFIG.AUDIO.SAMPLE_RATE, 24); // Sample rate
    header.writeUInt32LE(CONFIG.AUDIO.SAMPLE_RATE * CONFIG.AUDIO.CHANNELS * CONFIG.AUDIO.BYTES_PER_SAMPLE, 28); // Byte rate
    header.writeUInt16LE(CONFIG.AUDIO.CHANNELS * CONFIG.AUDIO.BYTES_PER_SAMPLE, 32); // Block align
    header.writeUInt16LE(CONFIG.AUDIO.BYTES_PER_SAMPLE * 8, 34); // Bits per sample
    
    // data subchunk
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40); // Data size
    
    return header;
}

/**
 * Writes audio buffer to a temporary WAV file
 * @param {Buffer} audioData - Raw PCM audio data
 * @param {string} filePath - Path to write the WAV file
 */
function writeWavFile(audioData, filePath) {
    const header = createWavHeader(audioData.length);
    const wavData = Buffer.concat([header, audioData]);
    fs.writeFileSync(filePath, wavData);
}

//=============================================================================
// WHISPER TRANSCRIPTION
//=============================================================================

/**
 * Transcribes audio using Whisper via Python subprocess
 * @param {string} wavFilePath - Path to the WAV file to transcribe
 * @returns {Promise<string>} - Transcribed text
 */
function transcribeWithWhisper(wavFilePath) {
    return new Promise((resolve, reject) => {
        const languageArg = CONFIG.LANGUAGE ? `language="${CONFIG.LANGUAGE}",` : '';
        
        const pythonScript = `
import whisper
import warnings
import sys

warnings.filterwarnings("ignore")

try:
    model = whisper.load_model("${CONFIG.MODEL}")
    result = model.transcribe(
        "${wavFilePath}",
        ${languageArg}
        fp16=False,
        beam_size=5,
        best_of=5,
        temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
        compression_ratio_threshold=2.4,
        logprob_threshold=-1.0,
        no_speech_threshold=0.6,
        condition_on_previous_text=False,
        initial_prompt="This is a conversation in Singlish, a mix of English with Mandarin, Malay, and Tamil words. Common particles include lah, leh, lor, meh, hor, sia."
    )
    print(result["text"].strip())
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
`;

        const python = spawn('python3', ['-c', pythonScript], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        python.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        python.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        python.on('close', (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(`Whisper process exited with code ${code}: ${stderr}`));
            }
        });

        python.on('error', (err) => {
            reject(new Error(`Failed to start Whisper process: ${err.message}`));
        });
    });
}

/**
 * Process a single audio chunk
 * @param {Buffer} audioData - Audio data to process
 * @param {number} chunkId - Chunk identifier for logging
 */
async function processAudioChunk(audioData, chunkId) {
    const tempDir = os.tmpdir();
    const wavFilePath = path.join(tempDir, `whisper_chunk_${chunkId}_${Date.now()}.wav`);
    
    try {
        // Write audio to temporary WAV file
        writeWavFile(audioData, wavFilePath);
        
        const startTime = Date.now();
        
        // Transcribe with Whisper
        const transcription = await transcribeWithWhisper(wavFilePath);
        
        const processingTime = Date.now() - startTime;
        
        if (transcription && transcription.length > 0) {
            console.log(`[Whisper] Transcription (chunk ${chunkId}, ${processingTime}ms): ${transcription}`);
        } else {
            console.log(`[Whisper] No speech detected in chunk ${chunkId} (${processingTime}ms)`);
        }
        
    } catch (error) {
        console.error(`[Whisper] Transcription error for chunk ${chunkId}:`, error.message);
    } finally {
        // Clean up temporary file
        try {
            if (fs.existsSync(wavFilePath)) {
                fs.unlinkSync(wavFilePath);
            }
        } catch (cleanupError) {
            console.error(`[Whisper] Failed to clean up temp file: ${cleanupError.message}`);
        }
    }
}

/**
 * Process the next item in the queue
 */
async function processNextInQueue() {
    if (isProcessing || processQueue.length === 0) {
        return;
    }
    
    isProcessing = true;
    const { audioData, chunkId } = processQueue.shift();
    
    try {
        await processAudioChunk(audioData, chunkId);
    } finally {
        isProcessing = false;
        // Process next item if available
        if (processQueue.length > 0) {
            setImmediate(processNextInQueue);
        }
    }
}

//=============================================================================
// PUBLIC API
//=============================================================================

/**
 * Feed audio chunk to the transcription service
 * @param {Buffer} chunk - Raw PCM audio data from RTMS
 */
export function sendAudioChunk(chunk) {
    if (!chunk || chunk.length === 0) {
        console.log('[Whisper] Received empty chunk, skipping');
        return;
    }
    
    audioBuffer.push(chunk);
    totalBufferedBytes += chunk.length;
    
    if (totalBufferedBytes % 10000 < chunk.length) {
        console.log(`[Whisper] Buffer: ${totalBufferedBytes}/${TARGET_CHUNK_SIZE} bytes (${Math.round(totalBufferedBytes/TARGET_CHUNK_SIZE*100)}%)`);
    }
    
    if (totalBufferedBytes >= TARGET_CHUNK_SIZE) {
        console.log(`[Whisper] Chunk ready! Processing ${totalBufferedBytes} bytes...`);
        const combinedBuffer = Buffer.concat(audioBuffer);
        
        // Extract the chunk to process
        const chunkToProcess = combinedBuffer.subarray(0, TARGET_CHUNK_SIZE);
        
        // Keep remaining data in buffer
        const remainingData = combinedBuffer.subarray(TARGET_CHUNK_SIZE);
        audioBuffer = remainingData.length > 0 ? [remainingData] : [];
        totalBufferedBytes = remainingData.length;
        
        // Increment chunk counter
        chunkCounter++;
        
        // Add to processing queue
        processQueue.push({
            audioData: chunkToProcess,
            chunkId: chunkCounter
        });
        
        // Trigger processing
        processNextInQueue();
    }
}

/**
 * Initialize the Whisper transcription service
 * Verifies that Python and Whisper are available
 */
export async function initWhisperTranscription() {
    console.log('[Whisper] Verifying installation...');
    
    return new Promise((resolve, reject) => {
        const checkScript = `
import sys
try:
    import whisper
    print(f"Whisper version: {whisper.__version__}")
    print("OK")
except ImportError as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
`;

        const python = spawn('python3', ['-c', checkScript], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        python.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        python.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        python.on('close', (code) => {
            if (code === 0) {
                console.log(`[Whisper] ${stdout.trim()}`);
                console.log('[Whisper] Ready for transcription');
                resolve();
            } else {
                const errorMsg = `Whisper not properly installed: ${stderr}`;
                console.error(`[Whisper] ${errorMsg}`);
                console.error('[Whisper] Please run: pip install -r requirements.txt');
                reject(new Error(errorMsg));
            }
        });

        python.on('error', (err) => {
            const errorMsg = `Python3 not found or not accessible: ${err.message}`;
            console.error(`[Whisper] ${errorMsg}`);
            reject(new Error(errorMsg));
        });
    });
}

/**
 * Cleanup and process any remaining audio in buffer
 */
export async function closeWhisperTranscription() {
    console.log('[Whisper] Closing transcription service...');
    
    // Process any remaining buffered audio
    if (totalBufferedBytes > 0 && audioBuffer.length > 0) {
        const combinedBuffer = Buffer.concat(audioBuffer);
        
        // Only process if we have at least 0.5 seconds of audio
        const minBytes = (CONFIG.AUDIO.SAMPLE_RATE * CONFIG.AUDIO.CHANNELS * CONFIG.AUDIO.BYTES_PER_SAMPLE * 500) / 1000;
        
        if (combinedBuffer.length >= minBytes) {
            chunkCounter++;
            console.log(`[Whisper] Processing final chunk (${combinedBuffer.length} bytes)...`);
            await processAudioChunk(combinedBuffer, chunkCounter);
        }
    }
    
    // Clear state
    audioBuffer = [];
    totalBufferedBytes = 0;
    processQueue = [];
    
    console.log('[Whisper] Transcription service closed');
}

export { CONFIG };
