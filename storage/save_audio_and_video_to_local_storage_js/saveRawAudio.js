import fs from 'fs';
import path from 'path';

// Cache for open write streams
const writeStreams = new Map();

export function saveRawAudio(chunk, meetingUuid,user_id) {

    const safeMeetingUuid = sanitizeFileName(meetingUuid);

    // Build path: recordings/{meetingUuid}/{safeUserName}_{userId}.raw
    const filePath = `recordings/${safeMeetingUuid}/${user_id}.raw`;

  // If the folder doesn't exist yet, create it

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Check if a stream already exists for this file
  let stream = writeStreams.get(filePath);
  if (!stream) {
    stream = fs.createWriteStream(filePath, { flags: 'a' }); // append mode
    writeStreams.set(filePath, stream);
  }

  stream.write(chunk);
}

// (Optional) Close all streams when needed
export function closeAllStreams() {
  for (const stream of writeStreams.values()) {
    stream.end();
  }
  writeStreams.clear();
}


function sanitizeFileName(name) {
    return name.replace(/[<>:"\/\\|?*=\s]/g, '_');
  }
