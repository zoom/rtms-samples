import { EventEmitter } from 'events';

export class AudioGapFiller extends EventEmitter {
    constructor(options = {}) {
        super();
        this.sampleRate = options.sampleRate || 16000;
        this.frameDuration = options.frameDuration || 20;
        this.gapThreshold = options.gapThreshold || 100;
        
        this.timer = null;
        this.isStopped = false;
        this.lastDataTime = null;
        this.muteState = 'active';
        this.firstMediaReceived = false;
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
                const silentFrame = this.generateSilentFrame();
                this.emit('data', { buffer: silentFrame, timestamp: now, isFiller: true });
            }
            console.log(`[AudioGapFiller] Mute detected: injected ${framesToInject} frames to cover ${gap}ms gap`);
            this.muteState = 'muted';
        } else if (this.muteState === 'muted') {
            const silentFrame = this.generateSilentFrame();
            this.emit('data', { buffer: silentFrame, timestamp: now, isFiller: true });
        }
    }

    push(data, timestamp) {
        if (!this.firstMediaReceived) {
            this.firstMediaReceived = true;
            console.log('[AudioGapFiller] First audio received - starting gap detection');
        }
        
        this.lastDataTime = Date.now();
        
        if (this.muteState !== 'active') {
            this.muteState = 'active';
            console.log('[AudioGapFiller] Audio returned: resetting to active state');
        }
        
        this.emit('data', { buffer: data, timestamp, isFiller: false });
    }

    generateSilentFrame() {
        const samples = (this.sampleRate * this.frameDuration) / 1000;
        return Buffer.alloc(samples * 2, 0);
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
    }
}

export default AudioGapFiller;
