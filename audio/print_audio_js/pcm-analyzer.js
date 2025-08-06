// pcm-analyzer.js

class PCMAnalyzer {
    constructor(options = {}) {
        this.sampleRate = options.sampleRate || 44100; // Hz
        this.bitDepth = options.bitDepth || 16;        // bits
        this.channels = options.channels || 1;         // mono or stereo
    }

    analyze(buffer, timestamp = Date.now()) {
        const byteDepth = this.bitDepth / 8;
        const frameSize = byteDepth * this.channels;

        const totalFrames = buffer.length / frameSize;
        const durationMs = (totalFrames / this.sampleRate) * 1000;
        const bitrate = this.sampleRate * this.bitDepth * this.channels; // bits per second

        const volumeInfo = this.computeVolume(buffer);

        const info = {
            timestamp,
            durationMs: parseFloat(durationMs.toFixed(2)),
            sampleRate: this.sampleRate,
            bitDepth: this.bitDepth,
            channels: this.channels === 1 ? 'Mono' : 'Stereo',
            frameSize: `${frameSize} bytes`,
            bufferLength: `${buffer.length} bytes`,
            bitrate: `${(bitrate / 1000).toFixed(1)} kbps`,
            peakDb: volumeInfo.peakDb,
            rmsDb: volumeInfo.rmsDb
        };

        console.log('🎧 PCM Frame Info:');
        console.log(`   Timestamp: ${new Date(timestamp).toISOString()}`);
        console.log(`   Duration: ${info.durationMs} ms`);
        console.log(`   Sample Rate: ${info.sampleRate} Hz`);
        console.log(`   Bit Depth: ${info.bitDepth}`);
        console.log(`   Channels: ${info.channels}`);
        console.log(`   Bitrate: ${info.bitrate}`);
        console.log(`   Frame Size: ${info.frameSize}`);
        console.log(`   Buffer Size: ${info.bufferLength}`);
        console.log(`   Peak Volume: ${info.peakDb} dB`);
        console.log(`   RMS Volume: ${info.rmsDb} dB\n`);

        return info;
    }

    computeVolume(buffer) {
        const sampleCount = buffer.length / 2; // 16-bit = 2 bytes
        let sumSquares = 0;
        let peak = 0;

        for (let i = 0; i < buffer.length; i += 2) {
            const sample = buffer.readInt16LE(i); // Little-endian 16-bit PCM
            const abs = Math.abs(sample);
            peak = Math.max(peak, abs);
            sumSquares += sample * sample;
        }

        const rms = Math.sqrt(sumSquares / sampleCount);

        const peakDb = peak === 0 ? -Infinity : 20 * Math.log10(peak / 32768);
        const rmsDb = rms === 0 ? -Infinity : 20 * Math.log10(rms / 32768);

        return {
            peakAmplitude: peak,
            rmsAmplitude: rms,
            peakDb: peakDb.toFixed(2),
            rmsDb: rmsDb.toFixed(2)
        };
    }
}

export default PCMAnalyzer;
