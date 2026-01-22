import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const runFFmpegCommand = promisify(exec);

// Utility function to sanitize file names
function sanitizeFileName(name) {
  return name.replace(/[<>:"\/\\|?*=\s]/g, '_');
}

// Asynchronous function to mux the first audio and video files
export async function muxFirstAudioVideo(meetingUuid) {
  const safeMeetingUuid = sanitizeFileName(meetingUuid);
  const folderPath = path.join('recordings', safeMeetingUuid);

  if (!fs.existsSync(folderPath)) {
    console.error(`❌ Meeting folder does not exist: ${folderPath}`);
    return;
  }

  const files = fs.readdirSync(folderPath);

  const wavFile = files.find(file => file.endsWith('.wav'));
  const mp4File = files.find(file => file.endsWith('.mp4'));

  if (!wavFile || !mp4File) {
    console.error('❌ Cannot find both a WAV and an MP4 file to mux.');
    return;
  }

  const audioPath = path.join(folderPath, wavFile);
  const videoPath = path.join(folderPath, mp4File);
  const outputPath = path.join(folderPath, 'final_output.mp4');

  const offsetSeconds = 0.0; // You can adjust this offset
  const command = `ffmpeg -i "${audioPath}" -i "${videoPath}" -itsoffset ${offsetSeconds} -i "${audioPath}" -map 1:v:0 -map 2:a:0 -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 64k -ar 16000 -ac 1 -shortest "${outputPath}"`;

  console.log(`🎥 Muxing ${mp4File} + ${wavFile} -> final_output.mp4`);

  try {
    await runFFmpegCommand(command);
    console.log('✅ Muxing completed. Output file created:', outputPath);
  } catch (error) {
    console.error('❌ Muxing failed:', error.message);
  }
}
