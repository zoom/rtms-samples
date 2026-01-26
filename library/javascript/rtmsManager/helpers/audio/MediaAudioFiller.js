import { EventEmitter } from 'events';

export class MediaAudioFiller extends EventEmitter {
    constructor(meetingUuid, streamId, userId, startTime, audioDetails = {}) {
        super();
        this.meetingUuid = meetingUuid;
        this.streamId = streamId;
        this.userId = userId;
        this.startTime = startTime || Date.now();
        this.expectedTimestamp = null; // Will be set from first packet
        this.isFirstPacket = true;

        // Map RTMS sample_rate enum to actual frequency
        const sampleRateMap = {
            1: 16000,
            2: 24000,
            3: 32000,
            4: 44100,
            5: 48000
        };
        this.sampleRate = sampleRateMap[audioDetails.sample_rate] || 16000;
        
        // Use send_rate for frame duration (default 20ms if not provided)
        this.frameDuration = audioDetails.send_rate || 20;
        this.timerInterval = this.frameDuration;
        
        this.buffer = [];
        this.timer = null;
        this.isStopped = false;

        // Pre-allocate silence buffer for this instance's frame duration (performance optimization)
        const silentSamples = (this.sampleRate * this.frameDuration) / 1000;
        this._silentFrame = Buffer.alloc(silentSamples * 2, 0);

        this.startTimer();
    }

    startTimer() {
        this.timer = setInterval(() => {
            if (this.isStopped) return;
            this.tick();
        }, this.timerInterval);
    }

    tick() {
        if (this.buffer.length === 0) {
            return;
        }

        if (this.isFirstPacket) {
            const firstPacket = this.buffer.shift();
            this.expectedTimestamp = firstPacket.timestamp;
            this.isFirstPacket = false;
            console.log(`[MediaAudioFiller] Synced to first packet timestamp: ${this.expectedTimestamp}ms`);
            this.emit('data', firstPacket.data, this.userId, firstPacket.timestamp, this.meetingUuid, this.streamId);
            return;
        }

        const candidate = this.buffer[0];
        const timeDiff = candidate.timestamp - this.expectedTimestamp;
        let dataToEmit;
        let timestampToEmit = this.expectedTimestamp;
        let isFiller = false;

        if (Math.abs(timeDiff) < this.frameDuration * 3) {
            const packet = this.buffer.shift();
            dataToEmit = packet.data;
            this.expectedTimestamp = packet.timestamp + this.frameDuration;
            timestampToEmit = packet.timestamp;
        } else if (timeDiff < -this.frameDuration * 10) {
            const packet = this.buffer.shift();
            console.log(`[MediaAudioFiller] Resyncing after large gap: ${timeDiff}ms behind, jumping to ${packet.timestamp}ms`);
            dataToEmit = packet.data;
            this.expectedTimestamp = packet.timestamp + this.frameDuration;
            timestampToEmit = packet.timestamp;
        } else if (timeDiff < 0) {
            this.buffer.shift();
            return;
        } else {
            dataToEmit = this.generateSilentAudioFrame(this.sampleRate, this.frameDuration);
            this.expectedTimestamp += this.frameDuration;
            isFiller = true;
        }

        if (isFiller) {
            this.logFiller(timestampToEmit, dataToEmit.length);
        } else {
            this.logReal(timestampToEmit, dataToEmit.length);
        }

        this.emit('data', dataToEmit, this.userId, timestampToEmit, this.meetingUuid, this.streamId);
    }

    logFiller(timestamp, dataSize) {
        const now = Date.now();
        if (!this.lastFillerLog || now - this.lastFillerLog > 1000) {
            console.log(`[MediaAudioFiller] 🔊 Filling gap for ${this.userId} at ${timestamp}ms (Buffer: ${this.buffer.length}, Size: ${dataSize})`);
            this.lastFillerLog = now;
        }
    }

    logReal(timestamp, dataSize) {
        const now = Date.now();
        if (!this.lastRealLog || now - this.lastRealLog > 5000) {
            console.log(`[MediaAudioFiller] Emitting real audio for ${this.userId} at ${timestamp}ms (Size: ${dataSize})`);
            this.lastRealLog = now;
        }
    }

    generateSilentAudioFrame(sampleRate, durationMs) {
        if (durationMs === this.frameDuration && sampleRate === this.sampleRate) {
            return Buffer.from(this._silentFrame);
        }
        const samples = (sampleRate * durationMs) / 1000;
        return Buffer.alloc(samples * 2, 0);
    }

    processBuffer(data, timestamp) {
        const last = this.buffer[this.buffer.length - 1];
        if (!last || timestamp >= last.timestamp) {
            this.buffer.push({ data, timestamp });
        } else {
            this.insertSorted({ data, timestamp });
        }
    }

    insertSorted(item) {
        // Binary search to find insertion point
        let left = 0;
        let right = this.buffer.length;

        while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (this.buffer[mid].timestamp < item.timestamp) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }

        // Insert at the correct position
        this.buffer.splice(left, 0, item);
    }

    stop(endTime) {
        this.isStopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }

        // Final fill if needed
        if (endTime && endTime > this.expectedTimestamp) {
            const remainingGap = endTime - this.expectedTimestamp;
            const frames = Math.floor(remainingGap / this.frameDuration);
            for (let i = 0; i < frames; i++) {
                const silentFrame = this.generateSilentAudioFrame(this.sampleRate, this.frameDuration);
                this.emit('data', silentFrame, this.userId, this.expectedTimestamp + (i * this.frameDuration), this.meetingUuid, this.streamId);
            }
        }
    }
}
