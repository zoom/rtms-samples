import { BlobServiceClient } from "@azure/storage-blob";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);

const allowedExtensions = ['.wav', '.mp4', '.vtt', '.srt', '.txt'];

function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*=\s]/g, '_');
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

export async function saveToAzure(meetingUuid) {
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

  const safeContainerName = sanitizeName('rtms'); // You can adjust this
  const containerClient = blobServiceClient.getContainerClient(safeContainerName);
  const exists = await containerClient.exists();
  if (!exists) {
    console.log(`🆕 Container ${safeContainerName} not found. Creating...`);
    await containerClient.create();
  } else {
    console.log(`✅ Container ${safeContainerName} exists.`);
  }

  for (const file of files) {
    const localFilePath = path.join(folderPath, file);
    console.log(`📄 Processing file: ${file}`);

    const blobName = `${safeMeetingUuid}/${file}`; // Same logic: meetingUuid as "folder" inside container
    const contentType = getContentTypeByExtension(file);

    console.log(`🚀 Uploading ${file} to Azure container ${safeContainerName} as blob: ${blobName}`);

    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const uploadStream = fs.createReadStream(localFilePath);

    const uploadOptions = {
      blobHTTPHeaders: { blobContentType: contentType }
    };

    try {
      await blockBlobClient.uploadStream(uploadStream, undefined, undefined, uploadOptions);
      console.log(`✅ Successfully uploaded: ${blobName} (Content-Type: ${contentType})`);
    } catch (error) {
      console.error(`❌ Failed to upload ${file}:`, error);
    }
  }

  console.log(`🏁 Finished uploading all allowed files for meeting ${meetingUuid}`);
}
