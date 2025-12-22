import path from 'path';
import fs from 'fs';
import whisper from 'whisper-node';
import { fileURLToPath } from 'url';
import type { SampleTranscript } from '../types.js';

const __filename = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const __dirname = path.dirname(__filename);
let transcriptBuffer = Buffer.alloc(0);

const transcribeAudio = async (buffer: Buffer<ArrayBuffer>) => {
    const bufferCopy = Buffer.from(buffer);
    const wavePath = await bufferToWaveFile(bufferCopy);
    const transcript: SampleTranscript = await whisper(wavePath, { modelName: "base.en" });
    console.log('*** Transcript ***\n', transcript);
    // delete file after transcribing
    fs.unlinkSync(wavePath);
    appendTranscriptToFile(transcript);
    console.log(transcript);
};

// audio data is sent as uncompressed raw PCM (L16) data with a 16kHz sample rate and mono channels. base64-encoded binary format
export const bufferToWaveFile = (buffer: Buffer<ArrayBuffer>) => {
    const wavePath = path.join(process.cwd(), `audio_${Date.now()}.wav`);

    // Decode base64 to binary buffer
    const pcmData = buffer;

    // Create WAV header
    const header = Buffer.alloc(44);
    const dataSize = pcmData.length;
    const fileSize = dataSize + 36;

    // RIFF chunk descriptor
    header.write('RIFF', 0);
    header.writeUInt32LE(fileSize, 4);
    header.write('WAVE', 8);

    // fmt sub-chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
    header.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
    header.writeUInt16LE(1, 22); // NumChannels (1 for mono)
    header.writeUInt32LE(16000, 24); // SampleRate (16000 Hz)
    header.writeUInt32LE(32000, 28); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
    header.writeUInt16LE(2, 32); // BlockAlign (NumChannels * BitsPerSample/8)
    header.writeUInt16LE(16, 34); // BitsPerSample (16 bits)

    // data sub-chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    // Combine header and audio data
    const wavFile = Buffer.concat([header, pcmData]);

    // Write to file
    fs.writeFileSync(wavePath, wavFile);

    return wavePath;
};

const appendTranscriptToFile = (transcript: SampleTranscript) => {
    // Format transcript text with proper spacing around punctuation
    // create file if not exist
    if (!fs.existsSync(path.join(process.cwd(), "transcript.txt"))) {
        fs.writeFileSync(path.join(process.cwd(), "transcript.txt"), "");
    }
    fs.appendFileSync(
        path.join(__dirname, "transcript.txt"),
        formatTranscript(transcript)
    );
};

export const concatBuffers = async (buffer: Buffer<ArrayBuffer>) => {
    transcriptBuffer = Buffer.concat([transcriptBuffer, buffer]);
    if (transcriptBuffer.length >= 16000 * 10) {
        void transcribeAudio(transcriptBuffer);
        transcriptBuffer = Buffer.alloc(0);
    }
};

export const formatTranscript = (transcript: SampleTranscript) => {
    let result = "";

    for (let i = 0; i < transcript.length; i++) {
        let current = transcript[i].speech.trim();
        if (!current) continue;

        // Handle apostrophes as part of the surrounding word (I + ' + m => I'm, That + 's => That's)
        if (current === "'" || current.startsWith("'")) {
            // attach apostrophe (and anything after it) directly to previous character (remove trailing space)
            result = result.replace(/ $/, "");
            result += current;
            continue;
        }

        // Collapse noisy "[ ina ud ible ]" / "[ BL ANK _ AUD IO ]" style tokens into a single bracketed tag
        if (current === "[") {
            // ensure a space before opening bracket if needed
            if (result && !result.endsWith(" ")) {
                result += " ";
            }

            let tagContent = "[";
            let closed = false;

            // consume tokens until we hit a closing bracket
            while (++i < transcript.length) {
                let inner = transcript[i].speech.trim();
                if (!inner) continue;

                // if this piece already contains a closing bracket, strip inner spaces then break
                if (inner.includes("]")) {
                    tagContent += inner.replace(/\s+/g, "");
                    closed = true;
                    break;
                }

                // otherwise, just append without spaces
                tagContent += inner.replace(/\s+/g, "");
            }

            if (!closed) {
                tagContent += "]";
            }

            result += tagContent;
            continue;
        }

        const isPunctuationOnly = /^[.,!?;:()]+$/.test(current);

        if (isPunctuationOnly) {
            // No space before punctuation
            result = result.replace(/ $/, "");
            result += current;

            // Space after sentence / clause punctuation
            if (/[.!?]/.test(current) || current === ",") {
                result += " ";
            }
            continue;
        }

        // Regular word/token
        if (result && !result.endsWith(" ")) {
            result += " ";
        }

        result += current;
    }

    return result;
};