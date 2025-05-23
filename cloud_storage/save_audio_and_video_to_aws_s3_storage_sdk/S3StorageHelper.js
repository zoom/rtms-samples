import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { fromEnv } from "@aws-sdk/credential-providers";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: fromEnv(),
});

// Only allow certain extensions
const allowedExtensions = ['.wav', '.mp4', '.vtt', '.srt', '.txt'];

function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*\s=]/g, "_");
}


function getContentTypeByExtension(filename) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.wav':
      return 'audio/wav';
    case '.mp4':
      return 'video/mp4';
    case '.vtt':
      return 'text/vtt';
    case '.srt':
      return 'application/x-subrip';
    case '.txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

async function saveToS3(meetingUuid) {
  console.log(`📁 Preparing to upload files for meeting: ${meetingUuid}`);
  const safeMeetingUuid = sanitizeName(meetingUuid);
  const folderPath = path.join('recordings', safeMeetingUuid);

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

  for (const file of files) {
    const localFilePath = path.join(folderPath, file);
    console.log(`📄 Processing file: ${file}`);

    const fileBuffer = fs.readFileSync(localFilePath);
    const contentType = getContentTypeByExtension(file);

    const key = `rtms/${safeMeetingUuid}/${file}`;
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
    } catch (error) {
      console.error(`❌ Failed to upload ${file}:`, error);
    }
  }

  console.log(`🏁 Finished uploading all allowed files for meeting ${meetingUuid}`);
}

export { saveToS3 };