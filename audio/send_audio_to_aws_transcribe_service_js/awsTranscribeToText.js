// Import necessary libraries and AWS SDK components
import { TranscribeStreamingClient, StartStreamTranscriptionCommand } from "@aws-sdk/client-transcribe-streaming";
import { PassThrough } from "stream";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

// AWS Transcribe configuration
const region = process.env.AWS_REGION || "us-east-1";
const languageCode = process.env.LANGUAGE_CODE || "en-US";

// Singleton AWS Transcribe client
let client = null;
let audioStream = null;
let transcriptionActive = false;

function getTranscribeClient() {
    if (!client) {
        client = new TranscribeStreamingClient({
            region,
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
        });
        console.log("AWS Transcribe client initialized.");
    }
    return client;
}

// Create an async generator that yields audio chunks
async function* audioStreamGenerator(stream) {
    for await (const chunk of stream) {
        yield { AudioEvent: { AudioChunk: chunk } };
    }
}

// Start or resume the persistent transcription stream
async function startPersistentTranscription() {
    if (transcriptionActive) return;

    transcriptionActive = true;
    audioStream = new PassThrough();

    const client = getTranscribeClient();

    const command = new StartStreamTranscriptionCommand({
        LanguageCode: languageCode,
        MediaSampleRateHertz: 16000,
        MediaEncoding: "pcm",
        AudioStream: audioStreamGenerator(audioStream), // Use the async generator here
    });

    try {
        console.log("Starting persistent real-time transcription...");
        const response = await client.send(command);

        // Listen to transcription results from the stream
        for await (const event of response.TranscriptResultStream) {
            if (event.TranscriptEvent) {
                const results = event.TranscriptEvent.Transcript.Results;
                for (const result of results) {
                    if (!result.IsPartial) {
                        console.log("Transcription:", result.Alternatives[0].Transcript);
                    }
                }
            }
        }
    } catch (error) {
        console.error("Error during persistent transcription:", error);
        transcriptionActive = false;
    }
}

// Feed audio data into the persistent stream
function feedAudioData(buffer) {
    if (!audioStream) {
        console.log("Audio stream not initialized, starting persistent transcription...");
        startPersistentTranscription();
    }
    audioStream.write(buffer);
}

// Export the transcription function for external use
export { feedAudioData };
