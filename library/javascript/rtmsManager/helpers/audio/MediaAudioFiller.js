import { EventEmitter } from 'events';

export class MediaAudioFiller extends EventEmitter {
    constructor(meetingUuid, streamId, userId, startTime, audioDetails = {}) {
        super();
        this.meetingUuid = meetingUuid;
        this.streamId = streamId;
        this.userId = userId;
        this.startTime = startTime || Date.now();
        this.expectedTimestamp = this.startTime;

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

        this.startTimer();
    }

    startTimer() {
        this.timer = setInterval(() => {
            if (this.isStopped) return;
            this.tick();
        }, this.timerInterval);
    }

    tick() {
        // Buffer is kept sorted via insertSorted() - no need to sort every tick
        let dataToEmit;
        let timestampToEmit = this.expectedTimestamp;
        let isFiller = false;

        if (this.buffer.length > 0) {
            const candidate = this.buffer[0];
            const timeDiff = candidate.timestamp - this.expectedTimestamp;

            // If the candidate is within a reasonable window (e.g., < 3x of frames duration for audio)
            if (timeDiff < this.frameDuration*3) {
                const packet = this.buffer.shift();
                dataToEmit = packet.data;
                // Update expected timestamp to the actual packet timestamp to stay in sync with source
                this.expectedTimestamp = packet.timestamp;
                timestampToEmit = packet.timestamp;
            } else if (timeDiff < 0) {
                // Packet is from the past, drop it to catch up
                this.buffer.shift();
                return; // Skip this tick
            } else {
                // Gap detected: emit silence
                dataToEmit = this.generateSilentAudioFrame(this.sampleRate, this.frameDuration);
                this.expectedTimestamp += this.frameDuration;
                isFiller = true;
            }
        } else {
            // No data in buffer: emit silence
            dataToEmit = this.generateSilentAudioFrame(this.sampleRate, this.frameDuration);
            this.expectedTimestamp += this.frameDuration;
            isFiller = true;
        }

        if (isFiller) {
            // Only log if the gap is significant to avoid spamming
            const now = Date.now();
            if (!this.lastFillerLog || now - this.lastFillerLog > 1000) {
                console.log(`[MediaAudioFiller] 🔊 Filling gap for ${this.userId} at ${timestampToEmit}ms (Buffer size: ${this.buffer.length}, Data size: ${dataToEmit.length})`);
                this.lastFillerLog = now;
            }
        } else {
            // Log real data emission occasionally for debugging
            const now = Date.now();
            if (!this.lastRealLog || now - this.lastRealLog > 5000) {
                console.log(`[MediaAudioFiller] Emitting real audio for ${this.userId} at ${timestampToEmit}ms (Data size: ${dataToEmit.length})`);
                this.lastRealLog = now;
            }
        }

        this.emit('data', dataToEmit, this.userId, timestampToEmit, this.meetingUuid, this.streamId);
    }

    generateSilentAudioFrame(sampleRate, durationMs) {
        const samples = (sampleRate * durationMs) / 1000;
        return Buffer.alloc(samples * 2, 0); // 16-bit PCM silence
    }

    processBuffer(data, timestamp) {
        // Insert into sorted position using binary search for O(log n) performance
        this.insertSorted({ data, timestamp });
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
