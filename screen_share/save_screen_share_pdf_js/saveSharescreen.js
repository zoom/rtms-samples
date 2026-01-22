import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import pixelmatch from 'pixelmatch';
import PDFDocument from 'pdfkit';

const meetingSessions = new Map();

export async function handleShareData(buffer, userId, timestamp, meetingId) {
  const isJPEG = buffer.slice(0, 2).equals(Buffer.from([0xff, 0xd8]));
  const isJPEGEnd = buffer.slice(-2).equals(Buffer.from([0xff, 0xd9]));

  if (!(isJPEG && isJPEGEnd)) {
    console.log('Only JPEG supported for screenshare uniqueness detection');
    return;
  }

  const MIN_SIZE = 1000;
  if (buffer.length < MIN_SIZE) {
    console.warn(`Skipping small JPEG (${buffer.length} bytes)`);
    return;
  }

  const safeMeetingId = meetingId?.toString().replace(/[^\w-]/g, '_') || 'unknown';

  if (!meetingSessions.has(meetingId)) {
    meetingSessions.set(meetingId, {
      uniqueFrameCounter: 0,
      lastAcceptedBuffer: null,
      uniqueFrames: []
    });
  }
  const session = meetingSessions.get(meetingId);

  const processedDir = path.resolve('recordings', safeMeetingId, 'processed', 'jpg');
  if (!fs.existsSync(processedDir)) {
    fs.mkdirSync(processedDir, { recursive: true });
  }

  let isDifferent = false;

  if (session.lastAcceptedBuffer === null) {
    isDifferent = true;
  } else {
    try {
      const currentRGBA = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const { width, height } = currentRGBA.info;
      const currentBuffer = currentRGBA.data;
      const lastBuffer = session.lastAcceptedBuffer;

      const totalPixels = width * height;
      const diffPixels = pixelmatch(currentBuffer, lastBuffer, null, width, height, { threshold: 0.1 });

      const diffRatio = diffPixels / totalPixels;
      if (diffRatio > 0.01) {
        isDifferent = true;
      }
    } catch (error) {
      console.error('Error comparing images:', error);
      isDifferent = true;
    }
  }

  if (isDifferent) {
    session.uniqueFrameCounter++;
    const fileName = `unique_${session.uniqueFrameCounter}.jpg`;
    const filePath = path.join(processedDir, fileName);

    fs.writeFileSync(filePath, buffer);

    try {
      const rgba = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      session.lastAcceptedBuffer = rgba.data;
    } catch (error) {
      console.error('Error processing RGBA for next comparison:', error);
    }

    session.uniqueFrames.push({ filePath, timestamp });
    console.log(`Saved unique JPEG ${session.uniqueFrameCounter} to: ${filePath} (${new Date(timestamp).toISOString()})`);
  } else {
    console.log(`Skipping similar frame at ${new Date(timestamp).toISOString()}`);
  }
}

export async function generatePDFAndText(meetingId) {
  const session = meetingSessions.get(meetingId);
  if (!session || session.uniqueFrames.length === 0) {
    console.log(`No unique frames for meeting ${meetingId}, skipping PDF generation`);
    return;
  }

  const safeMeetingId = meetingId?.toString().replace(/[^\w-]/g, '_') || 'unknown';
  console.log(`Generating PDF for meeting ${safeMeetingId} with ${session.uniqueFrames.length} frames`);

  const processedDir = path.resolve('recordings', safeMeetingId, 'processed');
  const pdfPath = path.join(processedDir, 'approved.pdf');
  const txtPath = path.join(processedDir, 'frames.txt');

  const doc = new PDFDocument();
  doc.pipe(fs.createWriteStream(pdfPath));

  for (const frame of session.uniqueFrames) {
    try {
      doc.image(frame.filePath, 0, 0, { width: 600 });
      doc.addPage();
    } catch (error) {
      console.error(`Error adding image ${frame.filePath} to PDF:`, error);
    }
  }

  doc.end();

  let txtContent = '';
  session.uniqueFrames.forEach((frame, index) => {
    const time = new Date(frame.timestamp).toISOString();
    txtContent += `Page ${index + 1}: ${time}\n`;
  });
  fs.writeFileSync(txtPath, txtContent);

  console.log(`PDF saved to: ${pdfPath}`);
  console.log(`Text file saved to: ${txtPath}`);

  meetingSessions.delete(meetingId);
}
