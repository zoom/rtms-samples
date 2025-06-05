// deepgram.js
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import dotenv from 'dotenv';

dotenv.config();
const deepgramApiKey = process.env.DEEPGRAM_API_KEY;

// Initialize the Deepgram client
const deepgramClient = createClient(deepgramApiKey);
let keepAlive;
let live;
let isConnected = false;
let audioQueue = [];

// Start or reuse the real-time transcription
export function startDeepgramTranscription() {
    console.log('[Deepgram] Setting up live transcription...');

    // If already connected, reuse the live object
    if (live && isConnected) {
        console.log('[Deepgram] Reusing existing live transcription session.');
        return live;
    }

    // Clear previous interval if any
    if (keepAlive) clearInterval(keepAlive);

    // Create a new live transcription stream
    live = deepgramClient.listen.live({
        model: "nova-3",
        smart_format: true,
        interim_results: true,
        punctuate: true,
        language: 'en-US',
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,  // Explicitly set to mono
    });

    console.log('[Deepgram] Live object created.');

    // Handle connection open
    live.addListener(LiveTranscriptionEvents.Open, async () => {
        console.log('[Deepgram] Connected');
        isConnected = true;

        // Send queued audio chunks once connected
        while (audioQueue.length > 0) {
            const chunk = audioQueue.shift();
            live.send(chunk);
            console.log('[Deepgram] Sent queued audio chunk, size:', chunk.length);
        }

        // Keep the connection alive every 10 seconds
        keepAlive = setInterval(() => {
            if (isConnected) {
                console.log('[Deepgram] Sending keep-alive message...');
                live.keepAlive();
            }
        }, 10 * 1000);
    });

    // Handle transcript received
    live.addListener(LiveTranscriptionEvents.Transcript, (data) => {
        console.log('[Deepgram] Transcript event received');
        if (data.channel.alternatives.length > 0) {
            const transcript = data.channel.alternatives[0].transcript;
            if (transcript) {
                console.log("[Deepgram] Transcription:", transcript);
            }
        }
    });

    // Handle connection close
    live.addListener(LiveTranscriptionEvents.Close, async () => {
        console.log('[Deepgram] Disconnected');
        isConnected = false;
        clearInterval(keepAlive);
        live.finish();
    });

    // Handle error
    live.addListener(LiveTranscriptionEvents.Error, async (error) => {
        console.error('[Deepgram] Error:', error);
        isConnected = false;
    });

    return live;
}

// Feed real-time audio chunks to Deepgram
export function sendAudioChunk(chunk) {
    if (!chunk || chunk.length === 0) return;

    // Log the size of the received audio chunk
    // console.log('[Deepgram] Received audio chunk of size:', chunk.length);

    if (isConnected && live) {
        try {
            live.send(chunk);
            //console.log('[Deepgram] Audio chunk sent, size:', chunk.length);
        } catch (error) {
            console.error('[Deepgram] Error sending chunk:', error);
        }
    } else {
        console.log('[Deepgram] Not connected, queueing chunk.');
        audioQueue.push(chunk);  // Queue the chunk if not connected
    }
}

// Close the Deepgram connection properly
export function closeDeepgram() {
    if (live) {
        console.log('[Deepgram] Closing transcription...');
        live.finish();
        clearInterval(keepAlive);
        live = null;
        isConnected = false;
    }
}
