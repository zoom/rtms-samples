// assemblyai.js
import { AssemblyAI } from "assemblyai";
import dotenv from "dotenv";

dotenv.config();
const assemblyApiKey = process.env.ASSEMBLYAI_API_KEY;

let transcriber;
let isConnected = false;
let audioQueue = [];

// Start or reuse the real-time transcription
export async function startAssemblyTranscription() {
    console.log('[AssemblyAI] Setting up live transcription...');

    // If already connected, reuse the transcriber object
    if (transcriber && isConnected) {
        console.log('[AssemblyAI] Reusing existing transcription session.');
        return transcriber;
    }

    try {
        // Initialize the AssemblyAI client
        const client = new AssemblyAI({
            apiKey: assemblyApiKey,
        });

        // Create a new transcriber object
        transcriber = client.realtime.transcriber({
            sampleRate: 16000,
        });

        // Handle successful connection
        transcriber.on("open", ({ sessionId }) => {
            console.log(`[AssemblyAI] Session opened with ID: ${sessionId}`);
            isConnected = true;

            // Send any queued audio chunks
            while (audioQueue.length > 0) {
                const chunk = audioQueue.shift();
                transcriber.sendAudio(chunk);
                //console.log('[AssemblyAI] Sent queued audio chunk, size:', chunk.length);
            }
        });

        // Handle errors
        transcriber.on("error", (error) => {
            console.error("[AssemblyAI] Error:", error);
            isConnected = false;
        });

        // Handle close event
        transcriber.on("close", (code, reason) => {
            console.log("[AssemblyAI] Session closed:", code, reason);
            isConnected = false;
        });

        // Handle received transcripts
        transcriber.on("transcript", (transcript) => {
            if (!transcript.text) return;

            if (transcript.message_type === "PartialTranscript") {
                console.log("[AssemblyAI] Partial:", transcript.text);
            } else {
                console.log("[AssemblyAI] Final:", transcript.text);
            }
        });

        // Connect to the real-time transcription service
        console.log("[AssemblyAI] Connecting to real-time transcript service...");
        await transcriber.connect();

        return transcriber;
    } catch (error) {
        console.error("[AssemblyAI] Failed to start transcription:", error);
    }
}

// Feed real-time audio chunks to AssemblyAI
export function sendAudioChunk(chunk) {
    if (!chunk || chunk.length === 0) return;

    if (isConnected && transcriber) {
        try {
            transcriber.sendAudio(chunk);
            console.log('[AssemblyAI] Audio chunk sent, size:', chunk.length);
        } catch (error) {
            console.error('[AssemblyAI] Error sending chunk:', error);
        }
    } else {
        console.log('[AssemblyAI] Not connected, queueing chunk.');
        audioQueue.push(chunk);  // Queue the chunk if not connected
    }
}

// Close the AssemblyAI transcription properly
export async function closeAssemblyTranscription() {
    if (transcriber) {
        console.log('[AssemblyAI] Closing transcription...');
        try {
            await transcriber.close();
            console.log('[AssemblyAI] Transcription closed.');
            isConnected = false;
        } catch (error) {
            console.error('[AssemblyAI] Error while closing transcription:', error);
        }
    }
}
