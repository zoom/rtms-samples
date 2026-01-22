import { spawn } from 'child_process';
import dotenv from 'dotenv';
dotenv.config();


export function startLocalTranscoding() {

      
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
      
        // 🔹 Encode video with improved quality settings
        '-c:v', 'libx264',
        '-preset', 'fast',           // Better quality than 'veryfast'
        '-tune', 'zerolatency',
        '-crf', '20',                // Constant Rate Factor for quality
        '-g', '50',                  // 25 fps * 2 sec
        '-keyint_min', '50',
        '-sc_threshold', '0',
        '-b:v', '4500k',             // Increased from 3000k for better quality
        '-maxrate', '5000k',         // Slightly higher max rate
        '-bufsize', '10000k',        // Larger buffer for quality
      
        // 🔹 Encode audio with higher quality
        '-c:a', 'aac',
        '-b:a', '192k',              // Increased from 128k
        '-ar', '44100',
      
        // 🔹 Output to HLS with optimized settings
        '-f', 'tee',
      
        `[f=hls:hls_time=2:hls_list_size=5:hls_flags=delete_segments+independent_segments]public/hls/stream.m3u8`
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
