import dotenv from 'dotenv';
import axios from 'axios';
import base64 from 'base-64';
import fs from 'fs';
import path from 'path';
import rtms from "@zoom/rtms";

dotenv.config();

// Maintain individual frame counters by user ID
const userFrameCounters = {};
const MAX_FILES_PER_USER = 3;





// ENV Vars
const clientId = process.env.ZOOM_CLIENT_ID;
const clientSecret = process.env.ZOOM_CLIENT_SECRET;
const accountId = process.env.ZOOM_ACCOUNT_ID;
const meetingNumber = process.env.ZOOM_MEETING_NUMBER;
const meetingPasscode = process.env.ZOOM_MEETING_PASSCODE;

const RETRY_FILE = './rooms_to_retry.json';
let roomsToRetry = [];

// Load existing retry file if it exists
function loadRetryList() {
  if (fs.existsSync(RETRY_FILE)) {
    const data = fs.readFileSync(RETRY_FILE);
    roomsToRetry = JSON.parse(data);
    console.log(`Loaded ${roomsToRetry.length} rooms from retry file.`);
  }
}

// Save updated retry list
function saveRetryList() {
  fs.writeFileSync(RETRY_FILE, JSON.stringify(roomsToRetry, null, 2));
  console.log(`Retry list saved to ${RETRY_FILE}`);
}

// Remove room from retry list by ID
function removeRoomFromRetryList(roomId) {
  roomsToRetry = roomsToRetry.filter(room => room.id !== roomId);
}

// Get access token
async function getAccessToken() {
  const credentials = base64.encode(`${clientId}:${clientSecret}`);
  const response = await axios.post(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`,
    {},
    {
      headers: {
        Authorization: `Basic ${credentials}`
      }
    }
  );
  return response.data.access_token;
}

// Get available rooms from Zoom
async function listMeetingRooms(accessToken) {
  const response = await axios.get(
    'https://api.zoom.us/v2/rooms?status=available',
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );
  return response.data.rooms;
}

// Join meeting
async function joinMeeting(accessToken, room) {
  const url = `https://api.zoom.us/v2/rooms/${room.id}/events`;
  const payload = {
    method: "zoomroom.meeting_join",
    params: {
      meeting_number: meetingNumber,
      passcode: meetingPasscode
    }
  };

  try {
    const response = await axios.patch(url, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      validateStatus: null  // We handle all statuses manually
    });

    if (response.status === 202) {
      console.log(`✅ Room ${room.name} joined meeting.`);
      removeRoomFromRetryList(room.id);
    } else {
      console.warn(`❌ Room ${room.name} failed with status ${response.status}`);
      const alreadyInList = roomsToRetry.find(r => r.id === room.id);
      if (!alreadyInList) {
        roomsToRetry.push({
          id: room.id,
          name: room.name,
          status: response.status,
          reason: response.data || "Unknown"
        });
      }
    }
  } catch (error) {
    console.error(`❌ Error joining room ${room.name}:`, error.message);
    const alreadyInList = roomsToRetry.find(r => r.id === room.id);
    if (!alreadyInList) {
      roomsToRetry.push({
        id: room.id,
        name: room.name,
        status: 'exception',
        reason: error.message
      });
    }
  }
}

// Leave meeting
async function leaveMeeting(accessToken, room) {
  const url = `https://api.zoom.us/v2/rooms/${room.id}/events`;
  const payload = {
    method: "zoomroom.meeting_leave",
    params: {}
  };

  try {
    const response = await axios.patch(url, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      validateStatus: null  // Handle all statuses manually
    });

    if (response.status === 202) {
      console.log(`✅ Room ${room.name} left the meeting.`);
    } else {
      console.warn(`❌ Failed to leave meeting for ${room.name}: Status ${response.status}`);
    }
  } catch (error) {
    console.error(`❌ Error leaving meeting for ${room.name}:`, error.message);
  }
}

// RTMS handler
function setupRTMSListener() {
  rtms.onWebhookEvent(({ event, payload }) => {
    console.log(`Received webhook event: ${event}`);

    if (event !== "meeting.rtms_started") {
      console.log(`Received event ${event}, ignoring...`);
      return;
    }

    const client = new rtms.Client();

    client.setVideoParams({
      contentType: rtms.VideoContentType.RAW_VIDEO,
      codec: rtms.VideoCodec.JPG,
      resolution: rtms.VideoResolution.HD,
      dataOpt: rtms.VideoDataOption.VIDEO_SINGLE_ACTIVE_STREAM,
      fps: 25
    });

    client.onVideoData((data, size, timestamp, metadata) => {
      const user = metadata.userName && metadata.userName.trim() !== '' ? metadata.userName : "unknown";
      const userId = metadata.userId || 'unknown';
      const frameTime = new Date(timestamp).toISOString();

      //console.log(`🎥 [VideoData] Size: ${size} bytes | User: ${user} (ID: ${userId}) | Timestamp: ${frameTime}`);

      try {
        const buffer = Buffer.from(data, 'base64');
        //console.log(`📦 Decoded buffer length: ${buffer.length} bytes`);

        saveVideoFrame(buffer, userId, timestamp,metadata.userName);
      } catch (err) {
        console.error(`❌ Failed to process video data for ${userId}:`, err.message);
      }
    });

    client.onAudioData((data, size, timestamp, metadata) => {
      const user = metadata.userName && metadata.userName.trim() !== '' ? metadata.userName : "mixed audio";
      //console.log(`Audio data: ${size} bytes from ${user}`);
    });

    client.onTranscriptData((data, size, timestamp, metadata) => {
      console.log(`${metadata.userName}: ${data}`);
    });

    client.join(payload);
  });
}

// Helper function to wait for a given number of milliseconds
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Main orchestration
async function main() {
  loadRetryList();
  const token = await getAccessToken();
  const availableRooms = await listMeetingRooms(token);

  // Merge retry list and available rooms (deduped by room.id)
  const allRooms = [...roomsToRetry, ...availableRooms].reduce((map, room) => {
    map[room.id] = room;
    return map;
  }, {});
  const uniqueRooms = Object.values(allRooms);

  // Try to join each room
  for (const room of uniqueRooms) {
    await joinMeeting(token, room);

    // Schedule leave after 20 seconds
    delay(30_000).then(() => leaveMeeting(token, room));
  }

  saveRetryList();
  setupRTMSListener();
}



function saveVideoFrame(videoData, user_id, timestamp, userName = '') {
  console.log(`📥 Received videoData for user: ${user_id}, timestamp: ${timestamp}`);

  let buffer;

  if (Buffer.isBuffer(videoData)) {
    buffer = videoData;
    console.log(`🔄 videoData is already a Buffer (length: ${buffer.length} bytes)`);
  } else if (typeof videoData === 'string') {
    try {
      buffer = Buffer.from(videoData, 'base64');
      console.log(`📦 Decoded base64 string to buffer. Length: ${buffer.length} bytes`);
    } catch (err) {
      console.error(`❌ Failed to decode base64: ${err.message}`);
      return;
    }
  } else {
    console.warn(`⚠️ videoData is of unsupported type: ${typeof videoData}`);
    return;
  }

  const isJPEG = buffer.slice(0, 2).equals(Buffer.from([0xff, 0xd8]));
  const isJPEGEnd = buffer.slice(-2).equals(Buffer.from([0xff, 0xd9]));
  const isPNG = buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const h264StartCodes = [Buffer.from([0x00, 0x00, 0x00, 0x01]), Buffer.from([0x00, 0x00, 0x01])];
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

  console.log(`🧪 Detected fileType: ${fileType}, fileExt: ${fileExt}`);

  const safeUserName = userName?.toString().replace(/[^\w-]/g, '_') || 'user';
  const safeUserId = user_id?.toString().replace(/[^\w-]/g, '_') || 'unknown';
  const userKey = `${safeUserName}_${safeUserId}`;

  if (!(userKey in userFrameCounters)) {
    console.log(`🆕 First frame for user: ${userKey}`);
    userFrameCounters[userKey] = 0;
  }
  userFrameCounters[userKey] += 1;
  const userFrameCount = userFrameCounters[userKey];
  console.log(`📈 Frame count for ${userKey}: ${userFrameCount}`);

  // Create user folder
  const userFolder = path.resolve('recordings', userKey);
  if (!fs.existsSync(userFolder)) {
    console.log(`📁 Creating folder: ${userFolder}`);
    fs.mkdirSync(userFolder, { recursive: true });
  }

  // Skip tiny JPEGs or first 3 frames
  if (fileType === 'jpeg') {
    const MIN_SIZE = 1000;
    if (buffer.length < MIN_SIZE) {
      console.warn(`⚠️ Skipping small JPEG (${buffer.length} bytes) from ${userKey}`);
      return;
    }
    if (userFrameCount <= 3) {
      console.log(`⏭️ Skipping initial JPEG frame #${userFrameCount} from ${userKey}`);
      return;
    }
  }

  // Generate full filename
  const fileName = `${timestamp}.${fileExt}`;
  const filePath = path.join(userFolder, fileName);

  if (fileType === 'jpeg' || fileType === 'png') {
    fs.writeFileSync(filePath, buffer);
    console.log(`💾 Saved ${fileType.toUpperCase()} for ${userKey} to: ${filePath}`);
  } else if (fileType === 'h264') {
    const h264FilePath = path.join(userFolder, `${safeUserName}_${safeUserId}.h264`);
    fs.appendFileSync(h264FilePath, buffer);
    console.log(`📹 Appended H.264 for ${userKey} to: ${h264FilePath}`);
  } else {
    console.warn(`⚠️ Unknown format from ${userKey}, skipping`);
    return;
  }

  // Enforce MAX_FILES_PER_USER
  if (fileType !== 'h264') {
    const files = fs.readdirSync(userFolder)
      .filter(f => f.endsWith(`.${fileExt}`))
      .map(f => ({ file: f, time: fs.statSync(path.join(userFolder, f)).mtimeMs }))
      .sort((a, b) => a.time - b.time); // oldest first

    while (files.length > MAX_FILES_PER_USER) {
      const oldest = files.shift();
      const toDelete = path.join(userFolder, oldest.file);
      fs.unlinkSync(toDelete);
      console.log(`🗑️ Deleted old file for ${userKey}: ${toDelete}`);
    }
  }
}



main().catch(console.error);
