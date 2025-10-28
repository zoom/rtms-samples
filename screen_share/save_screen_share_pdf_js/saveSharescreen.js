// handleShareData.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pixelmatch = require('pixelmatch');
const { createReadStream } = require('fs');

// Session state: Map<meetingUuid, { uniqueFrameCounter: number, lastAcceptedBuffer: Buffer, uniqueFrames: Array<{filePath: string, timestamp: number}> }>
const meetingSessions = new Map();

async function handleShareData(shareData, user_id, timestamp, meetingUuid) {
    // Strip base64 prefix if present
    if (typeof shareData === 'string' && shareData.startsWith('data:')) {
        shareData = shareData.split(',')[1];
    }

    let buffer = Buffer.from(shareData, 'base64');

    // Sanitize meetingUuid for safe folder names
    const safeMeetingUuid = meetingUuid.toString().replace(/[^\w-]/g, '_') || 'unknown';

    // Initialize session state if not exists
    if (!meetingSessions.has(meetingUuid)) {
        meetingSessions.set(meetingUuid, {
            uniqueFrameCounter: 0,
            lastAcceptedBuffer: null,  // RGBA buffer of last accepted frame
            uniqueFrames: []  // Array<{filePath: string, timestamp: number}>
        });
    }
    const session = meetingSessions.get(meetingUuid);

    // Detect file type
    let fileType = 'unknown';
    let fileExt = 'bin';

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

    // Only handle JPEG for screenshare
    if (!(isJPEG && isJPEGEnd)) {
        console.log('Only JPEG supported for screenshare uniqueness detection');
        return;
    }

    // Skip small frames
    const MIN_SIZE = 1000;
    if (buffer.length < MIN_SIZE) {
        console.warn(`⚠️ Skipping small JPEG (${buffer.length} bytes)`);
        return;
    }

    // Ensure processed folder exists
    const processedDir = path.resolve('recordings', safeMeetingUuid, 'processed', 'jpg');
    if (!fs.existsSync(processedDir)) {
        fs.mkdirSync(processedDir, { recursive: true });
    }

    // Decide if this frame is different enough
    let isDifferent = false;

    if (session.lastAcceptedBuffer === null) {
        // First frame, always accept
        isDifferent = true;
    } else {
        try {
            // Convert current buffer to RGBA
            const currentRGBA = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            const { width, height, channels } = currentRGBA.info;
            const currentBuffer = currentRGBA.data;

            // Last accepted is also RGBA with same dimensions (assuming screenshare consistent size)
            const lastBuffer = session.lastAcceptedBuffer;

            // Count differing pixels
            const totalPixels = width * height;
            const diffPixels = pixelmatch(currentBuffer, lastBuffer, null, width, height, { threshold: 0.1 }); // 0.1 threshold for pixel difference

            const diffRatio = diffPixels / totalPixels;
            if (diffRatio > 0.01) { // 1% threshold
                isDifferent = true;
            }
        } catch (error) {
            console.error('Error comparing images:', error);
            // On error, accept to be safe
            isDifferent = true;
        }
    }

    if (isDifferent) {
        // Increment counter and save
        session.uniqueFrameCounter++;
        const fileName = `unique_${session.uniqueFrameCounter}.jpg`;
        const filePath = path.join(processedDir, fileName);

        // Save JPEG
        fs.writeFileSync(filePath, buffer);

        // Update last accepted
        try {
            const rgba = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            session.lastAcceptedBuffer = rgba.data;
        } catch (error) {
            console.error('Error processing RGBA for next comparison:', error);
        }

        // Record unique frame
        session.uniqueFrames.push({ filePath, timestamp });

        console.log(`💾 Saved unique JPEG ${session.uniqueFrameCounter} to: ${filePath}  (${new Date(timestamp).toISOString()})`);
    } else {
        console.log(`⏭️ Skipping similar frame at ${new Date(timestamp).toISOString()}`);
    }
}

async function generatePDFAndText(meetingUuid) {
    const session = meetingSessions.get(meetingUuid);
    if (!session || session.uniqueFrames.length === 0) {
        console.log(`No unique frames for meeting ${meetingUuid}, skipping PDF generation`);
        return;
    }

    // Sanitize meetingUuid for safe folder names
    const safeMeetingUuid = meetingUuid.toString().replace(/[^\w-]/g, '_') || 'unknown';

    console.log(`Generating PDF for meeting ${safeMeetingUuid} with ${session.uniqueFrames.length} frames`);

    const PDFDocument = require('pdfkit');
    const processedDir = path.resolve('recordings', safeMeetingUuid, 'processed');
    const pdfPath = path.join(processedDir, 'approved.pdf');
    const txtPath = path.join(processedDir, 'frames.txt');

    // Create PDF
    const doc = new PDFDocument();
    doc.pipe(fs.createWriteStream(pdfPath));

    for (const frame of session.uniqueFrames) {
        try {
            // Add image to PDF (assuming A4, scale as needed)
            doc.image(frame.filePath, 0, 0, { width: 600 });
            doc.addPage();
        } catch (error) {
            console.error(`Error adding image ${frame.filePath} to PDF:`, error);
        }
    }

    doc.end();

    // Create text file
    let txtContent = '';
    session.uniqueFrames.forEach((frame, index) => {
        const time = new Date(frame.timestamp).toISOString();
        txtContent += `Page ${index + 1}: ${time}\n`;
    });
    fs.writeFileSync(txtPath, txtContent);

    console.log(`PDF saved to: ${pdfPath}`);
    console.log(`Text file saved to: ${txtPath}`);

    // Clean up session
    meetingSessions.delete(meetingUuid);
}

module.exports = { handleShareData, generatePDFAndText };
