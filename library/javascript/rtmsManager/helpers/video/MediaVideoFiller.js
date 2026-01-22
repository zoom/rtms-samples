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
        this.expectedTimestamp = this.startTime;

        // Calculate frame duration based on FPS (default 25fps -> 40ms)
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
        // Buffer is kept sorted via insertSorted() - no need to sort every tick
        let dataToEmit;
        let timestampToEmit = this.expectedTimestamp;
        let isFiller = false;

        if (this.buffer.length > 0) {
            const candidate = this.buffer[0];
            const timeDiff = candidate.timestamp - this.expectedTimestamp;

            // If the candidate is within a reasonable window (e.g., < 3x frameduration for video to handle jitter)
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
                // Gap detected: emit black frame
                dataToEmit = this.blackFrame;
                this.expectedTimestamp += this.frameDuration;
                isFiller = true;
            }
        } else {
            // No data in buffer: emit black frame
            dataToEmit = this.blackFrame;
            this.expectedTimestamp += this.frameDuration;
            isFiller = true;
        }

        // If it's the first frame or we are filling a gap, we might want to prepend SPS/PPS
        // For simplicity, we just emit the frame. 
        // If we want to be more robust, we could prepend this.spsPpsKeyframe to the first filler frame

        if (isFiller) {
            // Only log if the gap is significant (e.g., > 320ms) to avoid spamming
            const now = Date.now();
            if (!this.lastFillerLog || now - this.lastFillerLog > 1000) {
                console.log(`[MediaVideoFiller] 🎥 Filling gap for ${this.userId} at ${timestampToEmit}ms (Buffer size: ${this.buffer.length}, Data size: ${dataToEmit.length})`);
                this.lastFillerLog = now;
            }
        } else {
            // Log real data emission occasionally for debugging
            const now = Date.now();
            if (!this.lastRealLog || now - this.lastRealLog > 5000) {
                console.log(`[MediaVideoFiller] Emitting real video for ${this.userId} at ${timestampToEmit}ms (Data size: ${dataToEmit.length})`);
                this.lastRealLog = now;
            }
        }

        this.emit('data', dataToEmit, this.userId, timestampToEmit, this.meetingUuid, this.streamId);
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
