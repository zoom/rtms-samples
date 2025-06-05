// Load environment variables from .env file
import 'dotenv/config';

import rtms from "@zoom/rtms";
import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
let audioChunks = [];

rtms.onWebhookEvent(({ event, payload }) => {
  console.log(`RTMS Event: ${event}`); // Print the name of the incoming event
  console.log(`RTMS Event Payload: ${JSON.stringify(payload)}`); //Print the incoming payload


  if (event === "meeting.rtms_started") {
    const client = new rtms.Client();

    client.onAudioData((data) => {
      audioChunks.push(data);
    });

    client.join(payload);
  }

  if (event === "meeting.rtms_stopped") {
    if (audioChunks.length === 0) return;

    const meetingId = payload.meeting_uuid.replace(/[^a-zA-Z0-9]/g, "_");
    const rawFilename = `recording_${meetingId}.raw`;
    const wavFilename = `recording_${meetingId}.wav`;

    const combinedBuffer = Buffer.concat(audioChunks);
    fs.writeFileSync(rawFilename, combinedBuffer);

    convertRawToWav(rawFilename, wavFilename)
      .then(() => {
        console.log(`WAV saved: ${wavFilename}`);
        audioChunks = [];
      })
      .catch((err) => {
        console.error("Conversion error:", err);
        audioChunks = [];
      });
  }
});

async function convertRawToWav(inputFile, outputFile) {
  const command = `ffmpeg -y -f s16le -ar 16000 -ac 1 -i ${inputFile} ${outputFile}`;
  await execAsync(command);
  fs.unlinkSync(inputFile);
}