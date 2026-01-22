import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export class VideoJitterBuffer extends EventEmitter {
    constructor(options = {}) {
        super();
        this.fps = options.fps || 25;
        this.frameDuration = Math.floor(1000 / this.fps);
        this.tolerance = options.tolerance || 60;
        
        this.buffer = [];
        this.timer = null;
        this.isStopped = false;
        this.lastTimestamp = null;
        this.isFirstPacket = true;

        try {
            const __dirname = path.dirname(fileURLToPath(import.meta.url));
            this.blackFrame = fs.readFileSync(path.join(__dirname, 'black_frame.h264'));
        } catch (e) {
            console.warn('[VideoJitterBuffer] black_frame.h264 not found, using empty buffer');
            this.blackFrame = Buffer.alloc(0);
        }
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => {
            if (this.isStopped) return;
            this.tick();
        }, this.frameDuration);
    }

    tick() {
        this.buffer.sort((a, b) => a.timestamp - b.timestamp);

        let dataToEmit = this.blackFrame;
        let isFiller = true;
        const candidate = this.buffer[0];

        if (this.isFirstPacket && candidate) {
            this.lastTimestamp = candidate.timestamp;
            this.isFirstPacket = false;
            console.log(`[VideoJitterBuffer] Synced to first packet: ${this.lastTimestamp}ms`);
        }

        if (candidate) {
            const timeDiff = candidate.timestamp - this.lastTimestamp;

            if (timeDiff < this.tolerance) {
                const packet = this.buffer.shift();
                this.lastTimestamp = packet.timestamp;
                dataToEmit = packet.data;
                isFiller = false;
            } else {
                this.lastTimestamp += this.frameDuration;
            }
        } else if (this.lastTimestamp !== null) {
            this.lastTimestamp += this.frameDuration;
        }

        if (this.lastTimestamp !== null) {
            this.emit('data', { buffer: dataToEmit, timestamp: this.lastTimestamp, isFiller });
        }
    }

    push(data, timestamp) {
        this.buffer.push({ data, timestamp });
    }

    stop() {
        this.isStopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    reset() {
        this.buffer = [];
        this.lastTimestamp = null;
        this.isFirstPacket = true;
        this.isStopped = false;
    }
}

export default VideoJitterBuffer;
