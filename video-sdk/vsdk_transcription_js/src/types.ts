import WebSocket from 'ws';

// audio data is sent as uncompressed raw PCM (L16) data with a 16kHz sample rate and mono channels.
//Example audio packet:
export type SampleAudioPacket = {
    msg_type: 14;
    content: {
        user_id: number;
        user_name: string;
        data: string;
        timestamp: number;
    };
}

export type SampleTranscript = Array<{
    start: string;
    end: string;
    speech: string;
}>;

export interface Connection {
    sessionID: string;
    streamId: string;
    serverUrls: string;
    shouldReconnect: boolean;
    signaling: {
        socket: WebSocket | null;
        state: string;
        lastKeepAlive: number | null;
    };
    media: {
        socket: WebSocket | null;
        state: string;
        lastKeepAlive: number | null;
    };
}

export type ActiveConnections = Map<string, Connection>;
