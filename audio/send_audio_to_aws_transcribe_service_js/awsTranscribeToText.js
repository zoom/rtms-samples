import { TranscribeStreamingClient, StartStreamTranscriptionCommand } from "@aws-sdk/client-transcribe-streaming";
import { PassThrough } from "stream";
import dotenv from "dotenv";

dotenv.config();

const region = process.env.AWS_REGION || "us-east-1";
const languageCode = process.env.LANGUAGE_CODE || "en-US";

let client = null;
let audioStream = null;
let transcriptionActive = false;
let transcriptionFailed = false;

function getTranscribeClient() {
    if (!client) {
        client = new TranscribeStreamingClient({
            region,
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
        });
        console.log("✅ AWS Transcribe client initialized");
    }
    return client;
}

async function* audioStreamGenerator(stream) {
    try {
        for await (const chunk of stream) {
            yield { AudioEvent: { AudioChunk: chunk } };
        }
    } catch (err) {
    }
}

async function startPersistentTranscription() {
    if (transcriptionActive || transcriptionFailed) return;

    transcriptionActive = true;
    audioStream = new PassThrough();
    
    audioStream.on('error', (err) => {
        console.error(`❌ Audio stream error: ${err.message}`);
    });

    const transcribeClient = getTranscribeClient();

    const command = new StartStreamTranscriptionCommand({
        LanguageCode: languageCode,
        MediaSampleRateHertz: 16000,
        MediaEncoding: "pcm",
        AudioStream: audioStreamGenerator(audioStream),
    });

    try {
        console.log("🔗 Starting AWS Transcribe streaming...");
        const response = await transcribeClient.send(command);
        console.log("✅ AWS Transcribe streaming started");

        for await (const event of response.TranscriptResultStream) {
            if (event.TranscriptEvent) {
                const results = event.TranscriptEvent.Transcript.Results;
                for (const result of results) {
                    if (!result.IsPartial) {
                        console.log("📝 Transcription:", result.Alternatives[0].Transcript);
                    }
                }
            }
        }
    } catch (error) {
        const errorMessage = error.message || String(error);
        console.error(`❌ AWS Transcribe error: ${errorMessage}`);
        
        if (errorMessage.includes('security token') || errorMessage.includes('invalid') || errorMessage.includes('credentials')) {
            console.error("❌ Please check your AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
            transcriptionFailed = true;
        }
        
        transcriptionActive = false;
        if (audioStream) {
            audioStream.destroy();
            audioStream = null;
        }
    }
}

function feedAudioData(buffer) {
    if (transcriptionFailed) {
        return;
    }
    
    if (!audioStream && !transcriptionActive) {
        console.log("🎤 Audio stream not initialized, starting transcription...");
        startPersistentTranscription();
        return;
    }
    
    if (audioStream && !audioStream.destroyed) {
        audioStream.write(buffer);
    }
}

export { feedAudioData };
