import WebSocket from 'ws';
import querystring from 'querystring';
import dotenv from 'dotenv';

dotenv.config();

//=============================================================================
// CONFIGURATION
//=============================================================================

const CONFIG = {
    // Real-time transcription settings
    REALTIME: {
        ENABLED: process.env.REALTIME_ENABLED !== 'false', // Default: true
        MODE: process.env.REALTIME_MODE || 'mixed', // 'mixed' or 'individual'
    },
    
    // Audio settings
    AUDIO: {
        SAMPLE_RATE: parseInt(process.env.AUDIO_SAMPLE_RATE) || 16000,
        TARGET_CHUNK_DURATION_MS: parseInt(process.env.TARGET_CHUNK_DURATION_MS) || 100,
    }
};

// Environment variables
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;

// Validate API key
if (!ASSEMBLYAI_API_KEY) {
    console.error('❌ ASSEMBLYAI_API_KEY is required but not found in environment variables');
    process.exit(1);
}

// Audio streaming constants
const SAMPLE_RATE = CONFIG.AUDIO.SAMPLE_RATE;
const CHANNELS = 1; // Mono
const BYTES_PER_SAMPLE = 2;
const TARGET_CHUNK_SIZE = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * CONFIG.AUDIO.TARGET_CHUNK_DURATION_MS) / 1000;

// Active audio collectors and participant streams
const audioCollectors = new Map();
const participantStreams = new Map(); // For individual participant transcription

// AssemblyAI Streaming Configuration
const CONNECTION_PARAMS = {
    sample_rate: SAMPLE_RATE,
    format_turns: true,
};
const API_ENDPOINT_BASE_URL = "wss://streaming.assemblyai.com/v3/ws";
const API_ENDPOINT = `${API_ENDPOINT_BASE_URL}?${querystring.stringify(CONNECTION_PARAMS)}`;

console.log('🎧 AssemblyAI Transcription Service Initialized');
console.log(`   Real-time: ${CONFIG.REALTIME.ENABLED ? '✅' : '❌'} (${CONFIG.REALTIME.MODE})`);
console.log(`   Audio: ${SAMPLE_RATE}Hz, Target chunk: ${TARGET_CHUNK_SIZE} bytes`);
console.log(`   API Key: ${ASSEMBLYAI_API_KEY ? '✅ Set' : '❌ Missing'}`);

//=============================================================================
// INITIALIZATION FUNCTIONS
//=============================================================================

export function initializeAudioCollection(meetingUuid) {
    console.log(`🎤 Initializing audio collection for meeting ${meetingUuid}`);
    
    const collector = {
        audioBuffer: [],
        totalBytes: 0,
        chunkCount: 0,
        startTime: Date.now(),
        streamingWs: null,
        stopRequested: false,
    };
    
    audioCollectors.set(meetingUuid, collector);
    
    if (CONFIG.REALTIME.MODE === 'individual') {
        participantStreams.set(meetingUuid, new Map());
    }
    
    if (CONFIG.REALTIME.ENABLED) {
        initializeAssemblyAIStreaming(meetingUuid);
    }
}

function initializeAssemblyAIStreaming(meetingUuid) {
    const collector = audioCollectors.get(meetingUuid);
    if (!collector) return;

    if (CONFIG.REALTIME.MODE === 'mixed') {
        // Single stream for all participants
        initializeSingleStream(meetingUuid, collector);
    } else if (CONFIG.REALTIME.MODE === 'individual') {
        // Will create streams per participant as they're detected
        console.log(`🔗 Ready for individual participant streams for meeting ${meetingUuid}`);
    }
}

function initializeSingleStream(meetingUuid, collector) {
    console.log(`🔗 Connecting to AssemblyAI streaming for meeting ${meetingUuid}`);

    const streamingWs = new WebSocket(API_ENDPOINT, {
        headers: {
            Authorization: ASSEMBLYAI_API_KEY,
        },
    });

    collector.streamingWs = streamingWs;

    streamingWs.on('open', () => {
        console.log(`✅ AssemblyAI streaming connected for meeting ${meetingUuid}`);
    });

    streamingWs.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleAssemblyAIMessage(data, meetingUuid, 'mixed');
        } catch (error) {
            console.error(`❌ AssemblyAI message error: ${error}`);
        }
    });

    streamingWs.on('error', (error) => {
        console.error(`❌ AssemblyAI streaming error for meeting ${meetingUuid}: ${error}`);
        console.error(`❌ Error details: ${error.message}`);
        
        // Try to reconnect after a short delay
        setTimeout(() => {
            console.log(`🔄 Attempting to reconnect AssemblyAI for meeting ${meetingUuid}`);
            initializeSingleStream(meetingUuid, collector);
        }, 2000);
    });

    streamingWs.on('close', (code, reason) => {
        console.log(`🔌 AssemblyAI streaming closed for meeting ${meetingUuid}: ${code} - ${reason}`);
        
        // Log WebSocket close codes for debugging
        const closeReasons = {
            1000: 'Normal closure',
            1001: 'Going away',
            1002: 'Protocol error',
            1003: 'Unsupported data',
            1006: 'Abnormal closure',
            1011: 'Server error',
            1015: 'TLS handshake failure'
        };
        
        console.log(`🔍 Close reason: ${closeReasons[code] || 'Unknown'} (${code})`);
        
        // Try to reconnect if not intentionally stopped
        if (!collector.stopRequested && code !== 1000) {
            setTimeout(() => {
                console.log(`🔄 Attempting to reconnect AssemblyAI for meeting ${meetingUuid}`);
                initializeSingleStream(meetingUuid, collector);
            }, 2000);
        }
    });
}

function initializeParticipantStream(meetingUuid, participantId) {
    console.log(`🔗 Creating individual stream for participant ${participantId} in meeting ${meetingUuid}`);

    const streamingWs = new WebSocket(API_ENDPOINT, {
        headers: {
            Authorization: ASSEMBLYAI_API_KEY,
        },
    });

    const participantStreamsForMeeting = participantStreams.get(meetingUuid);
    participantStreamsForMeeting.set(participantId, {
        ws: streamingWs,
        buffer: [],
        stopRequested: false
    });

    streamingWs.on('open', () => {
        console.log(`✅ AssemblyAI streaming connected for participant ${participantId}`);
    });

    streamingWs.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleAssemblyAIMessage(data, meetingUuid, 'individual', participantId);
        } catch (error) {
            console.error(`❌ AssemblyAI message error for participant ${participantId}: ${error}`);
        }
    });

    streamingWs.on('error', (error) => {
        console.error(`❌ AssemblyAI streaming error for participant ${participantId}: ${error}`);
        const participantStream = participantStreamsForMeeting.get(participantId);
        if (participantStream) {
            participantStream.stopRequested = true;
        }
    });

    streamingWs.on('close', (code, reason) => {
        console.log(`🔌 AssemblyAI streaming closed for participant ${participantId}: ${code} - ${reason}`);
    });

    return streamingWs;
}

//=============================================================================
// MESSAGE HANDLING
//=============================================================================

function handleAssemblyAIMessage(data, meetingUuid, mode, participantId = null) {
    const msgType = data.type;
    const prefix = mode === 'individual' ? `[Participant ${participantId}]` : `[${meetingUuid.substring(0, 8)}]`;

    console.log(`🔍 AssemblyAI message: ${JSON.stringify(data)}`); // Debug logging

    if (msgType === "Begin") {
        console.log(`🚀 AssemblyAI session started: ${prefix}`);
    } else if (msgType === "Turn") {
        const transcript = data.transcript || "";
        const formatted = data.turn_is_formatted;

        if (formatted) {
            // Clear the line and print final transcript
            process.stdout.write('\r' + ' '.repeat(100) + '\r');
            console.log(`📝 ${prefix} FINAL: ${transcript}`);
        } else {
            // Show partial transcript (overwriting the same line)
            process.stdout.write(`\r🎙️ ${prefix} ${transcript}`);
        }
    } else if (msgType === "Termination") {
        console.log(`\n🏁 AssemblyAI session terminated: ${prefix}`);
    } else {
        console.log(`❓ Unknown AssemblyAI message type: ${msgType} - ${JSON.stringify(data)}`);
    }
}

//=============================================================================
// AUDIO PROCESSING FUNCTIONS
//=============================================================================

export function sendAudioChunk(buffer, meetingUuid, userId = 0) {
    //console.log(`🎵 sendAudioChunk called: buffer=${buffer.length} bytes, meeting=${meetingUuid}, user=${userId}`);
    
    if (!CONFIG.REALTIME.ENABLED) {
        console.log(`⏭️ Real-time transcription disabled`);
        return;
    }
    
    const collector = audioCollectors.get(meetingUuid);
    if (!collector) {
        console.log(`❌ No collector found for meeting ${meetingUuid}`);
        return;
    }
    
    if (collector.stopRequested) {
        console.log(`⏹️ Stop requested for meeting ${meetingUuid}`);
        return;
    }

    // Update statistics
    collector.totalBytes += buffer.length;
    collector.chunkCount++;

    // Send to appropriate AssemblyAI stream(s)
    if (CONFIG.REALTIME.MODE === 'mixed') {
        //console.log(`📤 Sending to mixed stream for meeting ${meetingUuid}`);
        sendToAssemblyAI(buffer, meetingUuid);
    } else if (CONFIG.REALTIME.MODE === 'individual') {
        //console.log(`📤 Sending to individual stream for user ${userId} in meeting ${meetingUuid}`);
        sendToParticipantStream(buffer, meetingUuid, userId);
    }

    // Log progress every 50 chunks (more frequent for debugging)
    if (collector.chunkCount % 50 === 0) {
        const duration = (Date.now() - collector.startTime) / 1000;
        //console.log(`🎵 [${meetingUuid.substring(0, 8)}] ${collector.chunkCount} chunks, ${collector.totalBytes} bytes, ${duration.toFixed(1)}s`);
    }
}

function sendToAssemblyAI(audioData, meetingUuid) {
    const collector = audioCollectors.get(meetingUuid);
    if (!collector) {
        console.log(`❌ sendToAssemblyAI: No collector for meeting ${meetingUuid}`);
        return;
    }
    
    if (!collector.streamingWs) {
        console.log(`❌ sendToAssemblyAI: No WebSocket for meeting ${meetingUuid}`);
        return;
    }
    
    if (collector.stopRequested) {
        console.log(`⏹️ sendToAssemblyAI: Stop requested for meeting ${meetingUuid}`);
        return;
    }

    collector.audioBuffer.push(audioData);
    
    const totalBufferedSize = collector.audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
    //console.log(`📊 Buffer size: ${totalBufferedSize}/${TARGET_CHUNK_SIZE} bytes`);
    
    if (totalBufferedSize >= TARGET_CHUNK_SIZE) {
        const combinedBuffer = Buffer.concat(collector.audioBuffer);
        const chunkToSend = combinedBuffer.subarray(0, TARGET_CHUNK_SIZE);
        const remainingData = combinedBuffer.subarray(TARGET_CHUNK_SIZE);
        
        collector.audioBuffer = remainingData.length > 0 ? [remainingData] : [];
        
        //console.log(`🌐 WebSocket state: ${collector.streamingWs.readyState} (1=OPEN)`);
        
        if (collector.streamingWs.readyState === WebSocket.OPEN) {
            try {
                collector.streamingWs.send(chunkToSend);
                //console.log(`✅ Sent ${chunkToSend.length} bytes to AssemblyAI for meeting ${meetingUuid}`);
            } catch (error) {
                console.error(`❌ Error sending to AssemblyAI: ${error}`);
            }
        } else {
            console.log(`❌ WebSocket not open, cannot send audio data`);
        }
    }
}

function sendToParticipantStream(audioData, meetingUuid, participantId) {
    const participantStreamsForMeeting = participantStreams.get(meetingUuid);
    if (!participantStreamsForMeeting) return;

    let participantStream = participantStreamsForMeeting.get(participantId);
    
    // Create stream for new participant
    if (!participantStream) {
        initializeParticipantStream(meetingUuid, participantId);
        participantStream = participantStreamsForMeeting.get(participantId);
    }

    if (!participantStream || participantStream.stopRequested) return;

    participantStream.buffer.push(audioData);
    
    const totalBufferedSize = participantStream.buffer.reduce((sum, chunk) => sum + chunk.length, 0);
    
    if (totalBufferedSize >= TARGET_CHUNK_SIZE) {
        const combinedBuffer = Buffer.concat(participantStream.buffer);
        const chunkToSend = combinedBuffer.subarray(0, TARGET_CHUNK_SIZE);
        const remainingData = combinedBuffer.subarray(TARGET_CHUNK_SIZE);
        
        participantStream.buffer = remainingData.length > 0 ? [remainingData] : [];
        
        if (participantStream.ws && participantStream.ws.readyState === WebSocket.OPEN) {
            try {
                participantStream.ws.send(chunkToSend);
                //console.log(`✅ Sent ${chunkToSend.length} bytes to AssemblyAI for participant ${participantId}`);
            } catch (error) {
                console.error(`❌ Error sending to AssemblyAI for participant ${participantId}: ${error}`);
            }
        }
    }
}

//=============================================================================
// CLEANUP FUNCTIONS
//=============================================================================

function flushAudioBuffer(meetingUuid) {
    const collector = audioCollectors.get(meetingUuid);
    if (!collector || collector.audioBuffer.length === 0) return;

    const combinedBuffer = Buffer.concat(collector.audioBuffer);
    const minChunkSize = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * 50) / 1000;
    
    if (combinedBuffer.length >= minChunkSize && collector.streamingWs?.readyState === WebSocket.OPEN) {
        try {
            collector.streamingWs.send(combinedBuffer);
            console.log(`🔄 Flushed remaining audio for meeting ${meetingUuid}`);
        } catch (error) {
            console.error(`❌ Error flushing audio: ${error}`);
        }
    }
    
    collector.audioBuffer = [];
}

function flushParticipantStreams(meetingUuid) {
    const participantStreamsForMeeting = participantStreams.get(meetingUuid);
    if (!participantStreamsForMeeting) return;

    for (const [participantId, participantStream] of participantStreamsForMeeting.entries()) {
        if (participantStream.buffer.length > 0) {
            const combinedBuffer = Buffer.concat(participantStream.buffer);
            const minChunkSize = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * 50) / 1000;
            
            if (combinedBuffer.length >= minChunkSize && participantStream.ws?.readyState === WebSocket.OPEN) {
                try {
                    participantStream.ws.send(combinedBuffer);
                    console.log(`🔄 Flushed remaining audio for participant ${participantId}`);
                } catch (error) {
                    console.error(`❌ Error flushing audio for participant ${participantId}: ${error}`);
                }
            }
            
            participantStream.buffer = [];
        }
    }
}

export async function cleanupMeeting(meetingUuid) {
    const collector = audioCollectors.get(meetingUuid);
    if (!collector) return;

    console.log(`🧹 Cleaning up meeting ${meetingUuid}`);
    
    collector.stopRequested = true;
    
    if (CONFIG.REALTIME.ENABLED) {
        if (CONFIG.REALTIME.MODE === 'mixed') {
            flushAudioBuffer(meetingUuid);
        } else if (CONFIG.REALTIME.MODE === 'individual') {
            flushParticipantStreams(meetingUuid);
        }
    }
    
    // Close AssemblyAI connections
    if (collector.streamingWs) {
        try {
            if (collector.streamingWs.readyState === WebSocket.OPEN) {
                collector.streamingWs.send(JSON.stringify({ type: "Terminate" }));
            }
            setTimeout(() => {
                if (collector.streamingWs) {
                    collector.streamingWs.close();
                }
            }, 1000);
        } catch (error) {
            console.error(`❌ Error closing AssemblyAI streaming: ${error}`);
        }
    }
    
    // Close individual participant streams
    const participantStreamsForMeeting = participantStreams.get(meetingUuid);
    if (participantStreamsForMeeting) {
        for (const [participantId, participantStream] of participantStreamsForMeeting.entries()) {
            try {
                if (participantStream.ws && participantStream.ws.readyState === WebSocket.OPEN) {
                    participantStream.ws.send(JSON.stringify({ type: "Terminate" }));
                    participantStream.ws.close();
                }
            } catch (error) {
                console.error(`❌ Error closing participant ${participantId} stream: ${error}`);
            }
        }
        participantStreams.delete(meetingUuid);
    }

    audioCollectors.delete(meetingUuid);
}

// Close the AssemblyAI transcription properly
export async function closeAssemblyTranscription(meetingUuid) {
    if (meetingUuid) {
        await cleanupMeeting(meetingUuid);
    } else {
        // Close all meetings
        for (const [uuid] of audioCollectors.entries()) {
            await cleanupMeeting(uuid);
        }
    }
}

//=============================================================================
// EXPORTS FOR CONFIGURATION
//=============================================================================

export { CONFIG };
