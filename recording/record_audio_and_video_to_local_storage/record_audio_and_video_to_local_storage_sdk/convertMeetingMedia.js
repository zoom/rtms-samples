import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const runFFmpegCommand = promisify(exec);

// Utility function to sanitize file names
function sanitizeFileName(name) {
  return name.replace(/[<>:"\/\\|?*=\s]/g, '_');
}

// Asynchronous function to convert meeting media files
export async function convertMeetingMedia(meetingUuid) {
  const safeMeetingUuid = sanitizeFileName(meetingUuid);

  const folderPath = path.join('recordings', safeMeetingUuid);

  if (!fs.existsSync(folderPath)) {
    console.error(`❌ Meeting folder does not exist: ${folderPath}`);
    return;
  }

  const files = fs.readdirSync(folderPath);

  for (const file of files) {
    const fullPath = path.join(folderPath, file);

    if (file.endsWith('.raw')) {
      // Convert raw PCM to WAV
      const outputWav = fullPath.replace('.raw', '.wav');
      const command = `ffmpeg -f s16le -ar 16000 -ac 1 -i "${fullPath}" "${outputWav}"`;

      console.log(`🎵 Converting audio: ${file} -> ${path.basename(outputWav)}`);
      await runFFmpegCommand(command);
    }

    if (file.endsWith('.h264')) {
      // Convert H264 to MP4
      const outputMp4 = fullPath.replace('.h264', '.mp4');
      const command = `ffmpeg -framerate 25 -i "${fullPath}" -c:v copy "${outputMp4}"`;

      console.log(`🎥 Converting video: ${file} -> ${path.basename(outputMp4)}`);
      await runFFmpegCommand(command);
    }
  }

  console.log(`🎯 All media converted for meeting ${meetingUuid}`);
}
