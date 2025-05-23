import { spawn } from 'child_process';
import dotenv from 'dotenv';
dotenv.config();

const YOUTUBE_STREAM_URL = `rtmp://a.rtmp.youtube.com/live2/${process.env.YOUTUBE_STREAM_KEY}`;

export function startYouTubeStream() {



    const ffmpeg = spawn('ffmpeg', [
        // 🔹 Input: 25 FPS raw H.264 video
        '-framerate', '25',
        '-f', 'h264',
        '-i', 'pipe:3',
      
        // 🔹 Input: mono PCM audio (16kHz)
        '-f', 's16le',
        '-ar', '16000',
        '-ac', '1',
        '-i', 'pipe:4',
      
        // 🔹 Process audio and video
        '-filter_complex',
        '[1:a]aresample=44100[aout];' +
        '[0:v]scale=1280:720:force_original_aspect_ratio=decrease,' +
        'pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[vout]',
      
        '-map', '[vout]',
        '-map', '[aout]',
      
        // 🔹 Encode video
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-g', '50',               // 25 fps * 2 sec
        '-keyint_min', '50',
        '-sc_threshold', '0',
        '-b:v', '3000k',          // ✅ YouTube 720p bitrate
        '-maxrate', '3000k',
        '-bufsize', '6000k',
      
        // 🔹 Encode audio
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
      
        // 🔹 Output to YouTube RTMP + HLS
        '-f', 'tee',
        `[f=flv]rtmp://a.rtmp.youtube.com/live2/${process.env.YOUTUBE_STREAM_KEY}` 
      ], {
        stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe']
      });

  const videoStream = ffmpeg.stdio[3];
  const audioStream = ffmpeg.stdio[4];

  ffmpeg.on('error', (err) => {
    console.error('❌ FFmpeg error:', err.message);
  });

  ffmpeg.on('exit', (code, signal) => {
    console.log(`❗ FFmpeg exited with code ${code}, signal ${signal}`);
  });

  return {
    ffmpeg,                   // ✅ <--- include this
    videoStream: ffmpeg.stdio[3],
    audioStream: ffmpeg.stdio[4],
  };
}
