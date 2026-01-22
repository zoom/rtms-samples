import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export class VideoGapFiller extends EventEmitter {
    constructor(options = {}) {
        super();
        this.fps = options.fps || 25;
        this.frameDuration = Math.floor(1000 / this.fps);
        this.gapThreshold = options.gapThreshold || 320;
        
        this.timer = null;
        this.isStopped = false;
        this.lastDataTime = null;
        this.muteState = 'active';
        this.firstMediaReceived = false;
        this.continuousStartTime = null;
        this.loopCount = 0;
        this.timeDriftAccumulate = 0;

        try {
            const __dirname = path.dirname(fileURLToPath(import.meta.url));
            this.blackFrame = fs.readFileSync(path.join(__dirname, 'black_frame.h264'));
        } catch (e) {
            console.warn('[VideoGapFiller] black_frame.h264 not found, using empty buffer');
            this.blackFrame = Buffer.alloc(0);
        }
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => {
            if (this.isStopped || !this.firstMediaReceived) return;
            this.tick();
        }, this.frameDuration);
    }

    tick() {
        const now = Date.now();
        const gap = now - this.lastDataTime;

        if (gap > this.gapThreshold && this.muteState === 'active') {
            const framesToInject = Math.ceil(gap / this.frameDuration);
            for (let i = 0; i < framesToInject; i++) {
                this.emit('data', { buffer: this.blackFrame, timestamp: now, isFiller: true });
            }
            console.log(`[VideoGapFiller] Mute detected: injected ${framesToInject} frames to cover ${gap}ms gap`);
            this.muteState = 'muted';
            this.continuousStartTime = now;
            this.loopCount = 0;
        } else if (this.muteState === 'muted') {
            this.emit('data', { buffer: this.blackFrame, timestamp: now, isFiller: true });
            
            this.loopCount++;
            if (this.loopCount >= 250) {
                const expectedTime = this.frameDuration * 250;
                const actualTime = now - this.continuousStartTime;
                const timeDifference = actualTime - expectedTime;
                this.timeDriftAccumulate += timeDifference;

                if (this.timeDriftAccumulate > this.frameDuration) {
                    const additionalFrames = Math.floor(this.timeDriftAccumulate / this.frameDuration);
                    for (let i = 0; i < additionalFrames; i++) {
                        this.emit('data', { buffer: this.blackFrame, timestamp: now, isFiller: true });
                    }
                    console.log(`[VideoGapFiller] Timing compensation: injected ${additionalFrames} additional frames (${this.timeDriftAccumulate}ms drift)`);
                    this.timeDriftAccumulate %= this.frameDuration;
                }
                this.continuousStartTime = now;
                this.loopCount = 0;
            }
        }
    }

    push(data, timestamp) {
        if (!this.firstMediaReceived) {
            this.firstMediaReceived = true;
            console.log('[VideoGapFiller] First video received - starting gap detection');
        }
        
        this.lastDataTime = Date.now();
        
        if (this.muteState !== 'active') {
            this.muteState = 'active';
            console.log('[VideoGapFiller] Video returned: resetting to active state');
        }
        
        this.emit('data', { buffer: data, timestamp, isFiller: false });
    }

    stop() {
        this.isStopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    reset() {
        this.lastDataTime = null;
        this.muteState = 'active';
        this.firstMediaReceived = false;
        this.isStopped = false;
        this.continuousStartTime = null;
        this.loopCount = 0;
        this.timeDriftAccumulate = 0;
    }
}

export default VideoGapFiller;
