import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { UUIDHelper } from '../filename/UUIDHelper.js';
import { convertRawToWav, mergeAudioFiles } from '../audio/audioHelper.js';
import { convertH264ToMp4, createVideoGrid } from '../video/videoHelper.js';

const execAsync = promisify(exec);

/**
 * Sanitizes a UUID by replacing non-alphanumeric characters with underscores.
 */
function sanitize(uuid) {
    return UUIDHelper.sanitize(uuid);
}

/**
 * Muxes an audio file and a video file into a single MP4 file.
 */
export async function muxAudioVideo(audioInput, videoInput, outputFile) {
    const command = `ffmpeg -y -i "${audioInput}" -i "${videoInput}" -map 1:v:0 -map 0:a:0 -c:v copy -c:a aac -shortest "${outputFile}"`;
    
    try {
        await execAsync(command);
    } catch (error) {
        throw new Error(`FFmpeg muxing failed: ${error.message}`);
    }
}

/**
 * Asynchronous function to convert meeting media files in a folder.
 */
export async function convertMeetingMedia(meetingUuid, streamId) {
  const safeMeetingUuid = sanitize(meetingUuid);
  const safeStreamId = sanitize(streamId);
  const folderPath = path.join(process.cwd(), 'recordings', safeMeetingUuid, safeStreamId);

  if (!fs.existsSync(folderPath)) {
    console.error(`❌ Meeting folder does not exist: ${folderPath}`);
    return;
  }

  const files = fs.readdirSync(folderPath);

  for (const file of files) {
    const fullPath = path.join(folderPath, file);

    if (file.endsWith('.raw')) {
      const outputWav = fullPath.replace('.raw', '.wav');
      console.log(`🎵 Converting audio: ${file} -> ${path.basename(outputWav)}`);
      await convertRawToWav(fullPath, outputWav);
    }

    if (file.endsWith('.h264')) {
      const outputMp4 = fullPath.replace('.h264', '.mp4');
      console.log(`🎥 Converting video: ${file} -> ${path.basename(outputMp4)}`);
      await convertH264ToMp4(fullPath, outputMp4);
    }
  }

  console.log(`🎯 All media converted for meeting ${safeMeetingUuid}`);
}

/**
 * Muxes matching userId.wav and userId.mp4 into userId.mp4
 */
export async function muxIndividualAudioVideo(meetingUuid, streamId) {
  const safeMeetingUuid = sanitize(meetingUuid);
  const safeStreamId = sanitize(streamId);
  const folderPath = path.join(process.cwd(), 'recordings', safeMeetingUuid, safeStreamId);

  if (!fs.existsSync(folderPath)) {
    console.error(`❌ Meeting folder does not exist: ${folderPath}`);
    return;
  }

  const files = fs.readdirSync(folderPath);
  const wavFiles = files.filter(file => file.endsWith('.wav') && !file.includes('mixed'));
  const mp4Files = files.filter(file => file.endsWith('.mp4') && !file.includes('mixed'));

  for (const wavFile of wavFiles) {
    const userId = path.parse(wavFile).name;
    const matchingMp4 = mp4Files.find(mp4 => path.parse(mp4).name === userId);

    if (matchingMp4) {
      const audioPath = path.join(folderPath, wavFile);
      const videoPath = path.join(folderPath, matchingMp4);
      const outputPath = path.join(folderPath, `${userId}_muxed.mp4`);

      console.log(`🎥 Muxing individual ${userId}: ${matchingMp4} + ${wavFile}`);
      try {
        await muxAudioVideo(audioPath, videoPath, outputPath);
        fs.renameSync(outputPath, path.join(folderPath, `${userId}.mp4`));
        console.log(`✅ Muxing completed for ${userId}`);
      } catch (error) {
        console.error(`❌ Muxing failed for ${userId}:`, error.message);
      }
    }
  }
}

/**
 * Muxes mixed audio and video only
 */
export async function muxMixedAudioVideo(meetingUuid, streamId) {
  const safeMeetingUuid = sanitize(meetingUuid);
  const safeStreamId = sanitize(streamId);
  const folderPath = path.join(process.cwd(), 'recordings', safeMeetingUuid, safeStreamId);

  if (!fs.existsSync(folderPath)) {
    console.warn(`⚠️ Skipping mixed muxing: folder does not exist: ${folderPath}`);
    return;
  }

  const combos = [
    { a: 'mixed_audio.wav', v: 'mixed_video.mp4', out: 'mixed_final.mp4' },
  ];

  for (const combo of combos) {
    const audioPath = path.join(folderPath, combo.a);
    const videoPath = path.join(folderPath, combo.v);
    const outputPath = path.join(folderPath, combo.out);

    if (fs.existsSync(audioPath) && fs.existsSync(videoPath)) {
      console.log(`🎥 Muxing combo: ${combo.v} + ${combo.a} -> ${combo.out}`);
      try {
        await muxAudioVideo(audioPath, videoPath, outputPath);
        console.log(`✅ Combo muxing completed: ${combo.out}`);
      } catch (error) {
        console.error(`❌ Combo muxing failed for ${combo.out}:`, error.message);
      }
    }
  }
}
/**
 * Muxes mixed audio and video combinations
 */
export async function muxMixedCombinationOfAudioAndVideo(meetingUuid, streamId) {
  const safeMeetingUuid = sanitize(meetingUuid);
  const safeStreamId = sanitize(streamId);
  const folderPath = path.join(process.cwd(), 'recordings', safeMeetingUuid, safeStreamId);

  if (!fs.existsSync(folderPath)) {
    console.warn(`⚠️ Skipping mixed muxing: folder does not exist: ${folderPath}`);
    return;
  }

  const combos = [
    { a: 'mixed_audio.wav', v: 'mixed_video.mp4', out: 'mixed_final.mp4' },
    { a: 'mixed_audio.wav', v: 'mixed_from_individual.mp4', out: 'mixed_audio_with_grid_video.mp4' },
    { a: 'mixed_from_individual.wav', v: 'mixed_video.mp4', out: 'merged_audio_with_mixed_video.mp4' },
    { a: 'mixed_from_individual.wav', v: 'mixed_from_individual.mp4', out: 'merged_audio_with_grid_video.mp4' }
  ];

  for (const combo of combos) {
    const audioPath = path.join(folderPath, combo.a);
    const videoPath = path.join(folderPath, combo.v);
    const outputPath = path.join(folderPath, combo.out);

    if (fs.existsSync(audioPath) && fs.existsSync(videoPath)) {
      console.log(`🎥 Muxing combo: ${combo.v} + ${combo.a} -> ${combo.out}`);
      try {
        await muxAudioVideo(audioPath, videoPath, outputPath);
        console.log(`✅ Combo muxing completed: ${combo.out}`);
      } catch (error) {
        console.error(`❌ Combo muxing failed for ${combo.out}:`, error.message);
      }
    }
  }
}

/**
 * Merges all individual userId.wav files into a single mixed_from_individual.wav
 */
export async function mergeIndividualAudio(meetingUuid, streamId) {
  const safeMeetingUuid = sanitize(meetingUuid);
  const safeStreamId = sanitize(streamId);
  const folderPath = path.join(process.cwd(), 'recordings', safeMeetingUuid, safeStreamId);

  if (!fs.existsSync(folderPath)) {
    console.warn(`⚠️ Skipping audio merge: folder does not exist: ${folderPath}`);
    return;
  }

  const files = fs.readdirSync(folderPath);
  const wavFiles = files.filter(file => file.endsWith('.wav') && !file.includes('mixed'));

  if (wavFiles.length < 2) {
    console.log(`ℹ️ Skipping audio merge: only ${wavFiles.length} individual file(s) found.`);
    return;
  }

  const inputFiles = wavFiles.map(f => path.join(folderPath, f));
  const outputPath = path.join(folderPath, 'mixed_from_individual.wav');

  console.log(`🔊 Merging ${wavFiles.length} audio files into mixed_from_individual.wav`);
  try {
    await mergeAudioFiles(inputFiles, outputPath);
    console.log(`✅ Audio merge completed: ${outputPath}`);
  } catch (error) {
    console.error(`❌ Audio merge failed:`, error.message);
  }
}

/**
 * Combines individual mp4 files into a grid layout saved as mixed_from_individual.mp4
 */
export async function mergeIndividualVideo(meetingUuid, streamId) {
  const safeMeetingUuid = sanitize(meetingUuid);
  const safeStreamId = sanitize(streamId);
  const folderPath = path.join(process.cwd(), 'recordings', safeMeetingUuid, safeStreamId);

  if (!fs.existsSync(folderPath)) {
    console.warn(`⚠️ Skipping video grid: folder does not exist: ${folderPath}`);
    return;
  }

  const files = fs.readdirSync(folderPath);
  const mp4Files = files.filter(file => file.endsWith('.mp4') && !file.includes('mixed'));

  if (mp4Files.length < 2) {
    console.log(`ℹ️ Skipping video grid: only ${mp4Files.length} individual file(s) found.`);
    return;
  }

  const inputFiles = mp4Files.map(f => path.join(folderPath, f));
  const outputPath = path.join(folderPath, 'mixed_from_individual.mp4');

  console.log(`🎥 Creating video grid (${mp4Files.length} inputs) -> mixed_from_individual.mp4`);
  try {
    await createVideoGrid(inputFiles, outputPath);
    console.log(`✅ Video grid completed: ${outputPath}`);
  } catch (error) {
    console.error(`❌ Video grid failed:`, error.message);
  }
}
