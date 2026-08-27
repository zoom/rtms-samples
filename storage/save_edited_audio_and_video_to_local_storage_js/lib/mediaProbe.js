import { spawn } from 'child_process';

export async function probeMedia(filePath) {
  const output = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=index,codec_type,width,height,r_frame_rate',
    '-of', 'json',
    filePath,
  ]);
  const parsed = JSON.parse(output);
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  const durationSeconds = Number(parsed.format?.duration);
  if (!video || !audio || !Number.isFinite(durationSeconds)) {
    throw new Error('The source recording must contain readable audio and video streams');
  }
  return {
    durationMs: Math.round(durationSeconds * 1000),
    width: video.width,
    height: video.height,
    frameRate: parseFrameRate(video.r_frame_rate),
  };
}

export function run(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${code}: ${stderr.slice(-4000)}`));
    });
  });
}

function parseFrameRate(value) {
  if (!value) return null;
  const [numerator, denominator = '1'] = value.split('/').map(Number);
  return denominator ? numerator / denominator : null;
}
