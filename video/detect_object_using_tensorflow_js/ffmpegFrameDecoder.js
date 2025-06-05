import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

export class H264FrameDecoder {
  constructor(outputDir, onFrameReady) {
    this.outputDir = outputDir;
    this.onFrameReady = onFrameReady;
    this.pendingFrames = [];

    this.framePath = path.join(this.outputDir, 'frame.jpg');

    this.ffmpeg = spawn('ffmpeg', [
      '-f', 'h264',
      '-i', 'pipe:0',
      '-vf', 'fps=1',
      '-update', '1',
      '-q:v', '2',
      this.framePath
    ]);

    fs.watch(this.outputDir, (eventType, filename) => {
      if (filename === 'frame.jpg') {
        const metadata = this.pendingFrames.shift(); // 🧠 Get the matching timestamp
        if (!metadata) return;
        const fullPath = path.join(this.outputDir, filename);
        this.onFrameReady(fullPath, metadata); // ✅ pass metadata (incl. timestamp)
      }
    });
  }

  writeChunk(buffer, metadata = {}) {
    this.pendingFrames.push(metadata); // 🧠 queue metadata for pairing
    this.ffmpeg.stdin.write(buffer);
  }

  close() {
    this.ffmpeg.stdin.end();
  }
}
