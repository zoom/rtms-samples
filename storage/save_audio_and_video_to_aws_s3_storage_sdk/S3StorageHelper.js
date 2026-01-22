import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { fromEnv } from "@aws-sdk/credential-providers";
import { UUIDHelper } from '../../library/javascript/commonHelpers/filename/UUIDHelper.js';
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const allowedExtensions = ['.wav', '.mp4', '.vtt', '.srt', '.txt'];

function getS3Client() {
  if (!process.env.AWS_REGION) {
    throw new Error('AWS_REGION environment variable is not set.');
  }
  if (!process.env.S3_BUCKET) {
    throw new Error('S3_BUCKET environment variable is not set.');
  }
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error('AWS credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) are not set.');
  }

  return new S3Client({
    region: process.env.AWS_REGION,
    credentials: fromEnv(),
  });
}

function getContentTypeByExtension(filename) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.wav': return 'audio/wav';
    case '.mp4': return 'video/mp4';
    case '.vtt': return 'text/vtt';
    case '.srt': return 'application/x-subrip';
    case '.txt': return 'text/plain';
    default: return 'application/octet-stream';
  }
}

export async function saveToS3(meetingUuid, streamId) {
  console.log(`📁 Preparing to upload files for meeting: ${meetingUuid}, stream: ${streamId}`);
  
  const s3 = getS3Client();
  
  const safeMeetingUuid = UUIDHelper.sanitize(meetingUuid);
  const safeStreamId = UUIDHelper.sanitize(streamId);
  const folderPath = path.join('recordings', safeMeetingUuid, safeStreamId);

  console.log(`📂 Checking local folder: ${folderPath}`);

  if (!fs.existsSync(folderPath)) {
    console.error(`❌ Folder not found: ${folderPath}`);
    return;
  }

  const allFiles = fs.readdirSync(folderPath);
  const files = allFiles.filter(file => allowedExtensions.includes(path.extname(file).toLowerCase()));

  console.log(`📝 Found ${files.length} allowed files to upload.`);

  if (files.length === 0) {
    console.warn(`⚠️ No allowed files found in ${folderPath}. Nothing to upload.`);
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (const file of files) {
    const localFilePath = path.join(folderPath, file);
    console.log(`📄 Processing file: ${file}`);

    const fileBuffer = fs.readFileSync(localFilePath);
    const contentType = getContentTypeByExtension(file);

    const key = `rtms/${safeMeetingUuid}/${safeStreamId}/${file}`;
    console.log(`🚀 Uploading ${file} to S3 bucket ${process.env.S3_BUCKET} at key: ${key}`);

    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: fileBuffer,
      ContentType: contentType,
    });

    try {
      await s3.send(command);
      console.log(`✅ Successfully uploaded: ${key} (Content-Type: ${contentType})`);
      successCount++;
    } catch (error) {
      console.error(`❌ Failed to upload ${file}:`, error.message);
      failCount++;
    }
  }

  console.log(`🏁 Finished S3 upload for meeting ${meetingUuid}: ${successCount} succeeded, ${failCount} failed`);
  
  if (failCount > 0) {
    throw new Error(`${failCount} file(s) failed to upload to S3`);
  }
}
