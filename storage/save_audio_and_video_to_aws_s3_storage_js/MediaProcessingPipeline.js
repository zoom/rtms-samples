import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function runFfmpeg(args, operation, ffmpegPath) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    process.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });
    process.once('error', () => reject(new Error(`FFmpeg could not start during ${operation}`)));
    process.once('close', (code) => {
      if (code === 0) resolve();
      else {
        const error = new Error(`FFmpeg ${operation} failed with exit code ${code}`);
        error.code = 'ffmpeg_failed';
        error.details = stderr;
        reject(error);
      }
    });
  });
}

export function createMediaProcessor({
  recordingsDir,
  uploadDirectory,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  fps = 25
}) {
  const root = path.resolve(recordingsDir);

  return async function processRecording(job) {
    const folder = path.resolve(root, job.relativeDirectory);
    if (folder !== root && !folder.startsWith(`${root}${path.sep}`)) {
      throw new Error('Recording job contains an invalid source directory');
    }

    const audioRaw = path.join(folder, 'mixed_audio.raw');
    const videoRaw = path.join(folder, 'mixed_video.h264');
    const audioWav = path.join(folder, 'mixed_audio.wav');
    const videoMp4 = path.join(folder, 'mixed_video.mp4');
    const finalMp4 = path.join(folder, 'mixed_final.mp4');

    if (await exists(audioRaw)) {
      await runFfmpeg([
        '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', audioRaw, audioWav
      ], 'audio conversion', ffmpegPath);
    }
    if (await exists(videoRaw)) {
      await runFfmpeg([
        '-framerate', String(fps), '-probesize', '50M', '-analyzeduration', '50M',
        '-i', videoRaw, '-c:v', 'copy', videoMp4
      ], 'video conversion', ffmpegPath);
    }
    if (await exists(audioWav) && await exists(videoMp4)) {
      await runFfmpeg([
        '-i', audioWav, '-i', videoMp4, '-map', '1:v:0', '-map', '0:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-shortest', finalMp4
      ], 'audio/video muxing', ffmpegPath);
    }

    return uploadDirectory(job.relativeDirectory);
  };
}
