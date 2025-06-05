
import fs from 'fs';
import path from 'path';

// Keep a simple map to reuse write streams
const videoWriteStreams = new Map();



export function saveRawVideo(buffer, userName, timestamp, meetingUuid) {

    
    const safeUserName = userName ? sanitizeFileName(userName) : 'default-view';
    const safeMeetingUuid = sanitizeFileName(meetingUuid);
    const outputDir = path.join('recordings', safeMeetingUuid);
 

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }


  const filePath = path.join(outputDir, `${userName}.h264`);

  let writeStream = videoWriteStreams.get(filePath);
  if (!writeStream) {
    writeStream = fs.createWriteStream(filePath, { flags: 'a' }); // append mode
    videoWriteStreams.set(filePath, writeStream);
  }

  writeStream.write(buffer);
  //console.log(`🎥 Video chunk written to ${filePath}`);
}

function sanitizeFileName(name) {
    return name.replace(/[<>:"\/\\|?*=\s]/g, '_');
  }
  
  