import fs from 'fs';
import path from 'path';

let srtIndex = 1;
let startTimestamp = null; // ✅ will hold first transcript timestamp

// 🔧 Set session start (optional external call)
export function setTranscriptStartTimestamp(ts) {
  startTimestamp = ts;
  console.log(`⏱️ Transcript start time set to: ${startTimestamp}`);
}

function formatVttTimestamp(ms) {
  const date = new Date(ms);
  if (isNaN(date.getTime())) return '00:00:00.000';

  const h = String(date.getUTCHours()).padStart(2, '0');
  const m = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  const msPart = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${msPart}`;
}

function formatSrtTimestamp(ms) {
  const date = new Date(ms);
  if (isNaN(date.getTime())) return '00:00:00,000';

  const h = String(date.getUTCHours()).padStart(2, '0');
  const m = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  const msPart = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s},${msPart}`;
}

// ✨ Accept meetingFolder as extra parameter
export function writeTranscriptToVtt(user_name, timestamp, data, meetingUuid) {

  const safeMeetingUuid = sanitizeFileName(meetingUuid);

  const meetingFolder= path.join('recordings', safeMeetingUuid);
  if (!fs.existsSync(meetingFolder)) {
    fs.mkdirSync(meetingFolder, { recursive: true });
  }

  if (!startTimestamp) {
    startTimestamp = timestamp; // fallback if not manually set
    console.log(`⚠️ startTimestamp not set — defaulting to first transcript line: ${startTimestamp}`);
  }

  // 🔥 Ensure the meeting folder exists
  if (!fs.existsSync(meetingFolder)) {
    fs.mkdirSync(meetingFolder, { recursive: true });
  }

  // Build output file paths inside the meeting folder
  const vttFilePath = path.join(meetingFolder, 'transcript.vtt');
  const srtFilePath = path.join(meetingFolder, 'transcript.srt');
  const txtFilePath = path.join(meetingFolder, 'transcript.txt');

  const relative = timestamp - startTimestamp;
  const start = formatVttTimestamp(relative);
  const end = formatVttTimestamp(relative + 2000);
  const vttLine = `${start} --> ${end}\n${user_name}: ${data}\n\n`;

  if (!fs.existsSync(vttFilePath)) {
    fs.writeFileSync(vttFilePath, 'WEBVTT\n\n');
  }
  fs.appendFileSync(vttFilePath, vttLine);
  //console.log(`📝 VTT saved to ${vttFilePath}`);

  const srtStart = formatSrtTimestamp(relative);
  const srtEnd = formatSrtTimestamp(relative + 2000);
  const srtLine = `${srtIndex++}\n${srtStart} --> ${srtEnd}\n${user_name}: ${data}\n\n`;

  fs.appendFileSync(srtFilePath, srtLine);
  //console.log(`🎞️ SRT saved to ${srtFilePath}`);

  const readableTime = new Date(timestamp).toISOString();
  const txtLine = `[${readableTime}] ${user_name}: ${data}\n`;
  fs.appendFileSync(txtFilePath, txtLine);
  //console.log(`📄 TXT saved to ${txtFilePath}`);
}


function sanitizeFileName(name) {
    return name.replace(/[^A-Za-z0-9._-]/g, '_');
  }
  