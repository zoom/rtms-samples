import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export class MediaVideoFiller extends EventEmitter {
    constructor(meetingUuid, streamId, userId, startTime, videoDetails = {}) {
        super();
        this.meetingUuid = meetingUuid;
        this.streamId = streamId;
        this.userId = userId;
        this.startTime = startTime || Date.now();
        this.expectedTimestamp = null; // Will be set from first packet
        this.isFirstPacket = true;

        const fps = videoDetails.fps || 25;
        this.frameDuration = Math.floor(1000 / fps);
        this.timerInterval = this.frameDuration;

        this.buffer = [];
        this.timer = null;
        this.isStopped = false;
        
        try {
            const __dirname = path.dirname(fileURLToPath(import.meta.url));
            this.blackFrame = fs.readFileSync(path.join(__dirname, 'black_frame.h264'));
            this.spsPpsKeyframe = fs.readFileSync(path.join(__dirname, 'sps_pps_keyframe.h264'));
        } catch (e) {
            console.warn('Filler files not found, using empty buffer');
            this.blackFrame = Buffer.alloc(0);
            this.spsPpsKeyframe = Buffer.alloc(0);
        }

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
            console.log(`[MediaVideoFiller] Synced to first packet timestamp: ${this.expectedTimestamp}ms`);
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
            // Large gap behind - RESYNC to new timestamp instead of dropping
            const packet = this.buffer.shift();
            console.log(`[MediaVideoFiller] Resyncing after large gap: ${timeDiff}ms behind, jumping to ${packet.timestamp}ms`);
            dataToEmit = packet.data;
            this.expectedTimestamp = packet.timestamp + this.frameDuration;
            timestampToEmit = packet.timestamp;
        } else if (timeDiff < 0) {
            // Small gap behind - drop packet
            this.buffer.shift();
            return;
        } else {
            dataToEmit = this.blackFrame;
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
            console.log(`[MediaVideoFiller] 🎥 Filling gap for ${this.userId} at ${timestamp}ms (Buffer: ${this.buffer.length}, Size: ${dataSize})`);
            this.lastFillerLog = now;
        }
    }

    logReal(timestamp, dataSize) {
        const now = Date.now();
        if (!this.lastRealLog || now - this.lastRealLog > 5000) {
            console.log(`[MediaVideoFiller] Emitting real video for ${this.userId} at ${timestamp}ms (Size: ${dataSize})`);
            this.lastRealLog = now;
        }
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
                this.emit('data', this.blackFrame, this.userId, this.expectedTimestamp + (i * this.frameDuration), this.meetingUuid, this.streamId);
            }
        }
    }
}
