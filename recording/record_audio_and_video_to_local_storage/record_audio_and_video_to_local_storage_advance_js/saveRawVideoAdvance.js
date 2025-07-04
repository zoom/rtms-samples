import fs from 'fs';
import path from 'path';



const spsWrittenMap = new Map();
const spsHeader = fs.readFileSync('sps_pps_keyframe.h264');

function hasStartCode(buffer) {
    return buffer.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01])) !== -1;
}

 const blackFrame = fs.readFileSync('black_frame.h264');

// Keep a simple map to reuse write streams
const videoWriteStreams = new Map();

// Define a map to store the last timestamps for each stream
const lastTimestamps = new Map();

// Generate a valid H.264 black frame dynamically
function generateDynamicBlackFrame(width, height) {
    // H.264 NAL unit header for an I-frame (keyframe)
    const nalHeader = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65]); // Start code + IDR slice (keyframe)
    // Frame size calculation (YUV420p format)
    const frameSize = width * height * 3 / 2; 
    const blackPixels = Buffer.alloc(frameSize, 0); // Black frame (YUV black)
    return Buffer.concat([nalHeader, blackPixels]);
}

function sanitizeFileName(name) {
    return name.replace(/[<>:"\/\\|?*=\s]/g, '_');
}

// export function saveRawVideo(buffer, userName, timestamp, meetingUuid) {
//     const safeUserName = userName ? sanitizeFileName(userName) : 'default-view';
//     const safeMeetingUuid = sanitizeFileName(meetingUuid);
//     const outputDir = path.join('recordings', safeMeetingUuid);

//     if (!fs.existsSync(outputDir)) {
//         fs.mkdirSync(outputDir, { recursive: true });
//     }

//     const filePath = path.join(outputDir, `${safeUserName}.h264`);

//     let writeStream = videoWriteStreams.get(filePath);
//     if (!writeStream) {
//         writeStream = fs.createWriteStream(filePath, { flags: 'a' }); // append mode
//         videoWriteStreams.set(filePath, writeStream);
//     }

//     // Retrieve the last timestamp for this user
//     const lastTimestamp = lastTimestamps.get(userName) || timestamp;
//     const timeDifference = timestamp - lastTimestamp;

//     // Frame rate of 25 FPS -> 40 ms per frame
//     if (timeDifference > 500) {
//         const numberOfFrames = Math.floor(timeDifference / 40); // ~25 fps approximation
//         console.log(`Detected gap of ${timeDifference}ms. Filling with ${numberOfFrames} black frames.`);

//         // for (let i = 0; i < numberOfFrames; i++) {
//         //     // Dynamically generate a black frame (width and height as per your stream settings)
//         //     const blackFrame = generateDynamicBlackFrame(640, 480); // Adjust to your video resolution
//         //     writeStream.write(blackFrame);
//         // }

    
//         for (let i = 0; i < numberOfFrames; i++) {
//             writeStream.write(blackFrame);
//         }
//     }

//     // Update the last timestamp and write the current buffer
//     lastTimestamps.set(userName, timestamp);
//     writeStream.write(buffer);
//     // console.log(`🎥 Video chunk written to ${filePath}`);
// }

export function saveRawVideo(buffer, userName, timestamp, meetingUuid) {
    const safeUserName = userName ? sanitizeFileName(userName) : 'default-view';
    const safeMeetingUuid = sanitizeFileName(meetingUuid);
    const outputDir = path.join('recordings', safeMeetingUuid);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const filePath = path.join(outputDir, `${safeUserName}.h264`);

    let writeStream = videoWriteStreams.get(filePath);
    if (!writeStream) {
        writeStream = fs.createWriteStream(filePath, { flags: 'a' });
        videoWriteStreams.set(filePath, writeStream);
    }

    // Step 1: Validate frame
    if (!hasStartCode(buffer)) {
        console.warn(`🚫 Invalid H.264 buffer received for user: ${userName}`);
        return;
    }

    // Step 2: Write SPS/PPS headers once per stream
    if (!spsWrittenMap.get(filePath)) {
        writeStream.write(spsHeader);
        spsWrittenMap.set(filePath, true);
    }

    // Step 3: Gap detection
    const lastTimestamp = lastTimestamps.get(userName) || timestamp;
    const timeDifference = timestamp - lastTimestamp;

    if (timeDifference > 500) {
        const missingFrames = Math.floor(timeDifference / 40); // assuming 25fps
        console.log(`🕳️ Gap detected (${timeDifference}ms). Filling ${missingFrames} black frames.`);

        for (let i = 0; i < missingFrames; i++) {
            writeStream.write(blackFrame);
        }
    }

    // Step 4: Write frame + update timestamp
    writeStream.write(buffer);
    lastTimestamps.set(userName, timestamp);
}