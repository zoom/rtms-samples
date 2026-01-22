import fs from 'fs';
import path from 'path';

let srtIndex = 1;
let sessionStartTime = null;

export function resetTranscriptSession() {
  srtIndex = 1;
  sessionStartTime = null;
}

function formatVttTimestamp(ms) {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = Math.floor(ms % 1000);

  const h = String(hours).padStart(2, '0');
  const m = String(minutes).padStart(2, '0');
  const s = String(seconds).padStart(2, '0');
  const msPart = String(milliseconds).padStart(3, '0');
  return `${h}:${m}:${s}.${msPart}`;
}

function formatSrtTimestamp(ms) {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = Math.floor(ms % 1000);

  const h = String(hours).padStart(2, '0');
  const m = String(minutes).padStart(2, '0');
  const s = String(seconds).padStart(2, '0');
  const msPart = String(milliseconds).padStart(3, '0');
  return `${h}:${m}:${s},${msPart}`;
}

function sanitizeFileName(name) {
  return name.replace(/[<>:"\/\\|?*=\s]/g, '_');
}

/**
 * Write transcript to VTT, SRT, and TXT files
 * @param {string} userName - Speaker name
 * @param {string} text - Transcript text
 * @param {string} meetingUuid - Meeting UUID for folder naming
 * @param {number} startTime - Utterance start time in milliseconds
 * @param {number} endTime - Utterance end time in milliseconds
 * @param {number} timestamp - Event timestamp in microseconds
 */
export function writeTranscriptToVtt(userName, text, meetingUuid, startTime, endTime, timestamp) {
  const safeMeetingUuid = sanitizeFileName(meetingUuid);
  const meetingFolder = path.join('recordings', safeMeetingUuid);
  
  if (!fs.existsSync(meetingFolder)) {
    fs.mkdirSync(meetingFolder, { recursive: true });
  }

  if (!sessionStartTime) {
    sessionStartTime = startTime;
    console.log(`[writeTranscript] Session start time set to: ${sessionStartTime}ms`);
  }

  const vttFilePath = path.join(meetingFolder, 'transcript.vtt');
  const srtFilePath = path.join(meetingFolder, 'transcript.srt');
  const txtFilePath = path.join(meetingFolder, 'transcript.txt');

  const relativeStart = startTime - sessionStartTime;
  const relativeEnd = endTime - sessionStartTime;

  const vttStart = formatVttTimestamp(relativeStart);
  const vttEnd = formatVttTimestamp(relativeEnd);
  const vttLine = `${vttStart} --> ${vttEnd}\n${userName}: ${text}\n\n`;

  if (!fs.existsSync(vttFilePath)) {
    fs.writeFileSync(vttFilePath, 'WEBVTT\n\n');
  }
  fs.appendFileSync(vttFilePath, vttLine);

  const srtStart = formatSrtTimestamp(relativeStart);
  const srtEnd = formatSrtTimestamp(relativeEnd);
  const srtLine = `${srtIndex++}\n${srtStart} --> ${srtEnd}\n${userName}: ${text}\n\n`;
  fs.appendFileSync(srtFilePath, srtLine);

  const absoluteTime = new Date(Math.floor(timestamp / 1000)).toISOString();
  const txtLine = `[${absoluteTime}] ${userName}: ${text}\n`;
  fs.appendFileSync(txtFilePath, txtLine);
}
