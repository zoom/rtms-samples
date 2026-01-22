import fs from 'fs';
import path from 'path';

let frameCounter = 0;

export function handleShareData(buffer, userId, timestamp, meetingId) {
  const isJPEG = buffer.slice(0, 2).equals(Buffer.from([0xff, 0xd8]));
  const isJPEGEnd = buffer.slice(-2).equals(Buffer.from([0xff, 0xd9]));
  const isPNG = buffer.slice(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  );
  const h264StartCodes = [
    Buffer.from([0x00, 0x00, 0x00, 0x01]),
    Buffer.from([0x00, 0x00, 0x01]),
  ];
  const isH264 = h264StartCodes.some(code => buffer.indexOf(code) === 0);

  let fileType = 'unknown';
  let fileExt = 'bin';

  if (isJPEG && isJPEGEnd) {
    fileType = 'jpeg';
    fileExt = 'jpg';
  } else if (isPNG) {
    fileType = 'png';
    fileExt = 'png';
  } else if (isH264) {
    fileType = 'h264';
    fileExt = 'h264';
  }

  frameCounter++;

  const safeMeetingId = meetingId?.toString().replace(/[^\w-]/g, '_') || 'unknown';
  const recordingsDir = path.resolve('recordings', safeMeetingId);
  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
  }

  const safeUserId = userId?.toString().replace(/[^\w-]/g, '_') || 'unknown';
  const baseFilename = `${safeUserId}_${timestamp}`;
  const filePath = path.join(recordingsDir, `${baseFilename}.${fileExt}`);

  if (fileType === 'jpeg') {
    const MIN_SIZE = 1000;
    if (buffer.length < MIN_SIZE) {
      console.warn(`Skipping small JPEG (${buffer.length} bytes)`);
      return;
    }
    if (frameCounter <= 3) {
      console.log(`Skipping initial JPEG frame #${frameCounter}`);
      return;
    }

    fs.writeFileSync(filePath, buffer);
    console.log(`Saved JPEG to: ${filePath}`);
  } else if (fileType === 'png') {
    fs.writeFileSync(filePath, buffer);
    console.log(`Saved PNG to: ${filePath}`);
  } else if (fileType === 'h264') {
    const h264FilePath = path.join(recordingsDir, `${safeUserId}.h264`);
    fs.appendFileSync(h264FilePath, buffer);
    console.log(`Appended H.264 data to: ${h264FilePath}`);
  } else {
    console.warn('Unknown or unsupported format - skipping');
  }
}

export function resetFrameCounter() {
  frameCounter = 0;
}
