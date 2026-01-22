import { BlobServiceClient } from "@azure/storage-blob";
import { UUIDHelper } from '../../library/javascript/commonHelpers/filename/UUIDHelper.js';
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;

const allowedExtensions = ['.wav', '.mp4', '.vtt', '.srt', '.txt'];

function getBlobServiceClient() {
  if (!AZURE_STORAGE_CONNECTION_STRING) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING environment variable is not set. Please configure it in your .env file.');
  }
  
  if (!AZURE_STORAGE_CONNECTION_STRING.includes('AccountName=') || !AZURE_STORAGE_CONNECTION_STRING.includes('AccountKey=')) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING appears to be invalid. It should contain AccountName and AccountKey.');
  }

  try {
    return BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
  } catch (error) {
    throw new Error(`Failed to create Azure Blob Service Client: ${error.message}. Check your AZURE_STORAGE_CONNECTION_STRING.`);
  }
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

export async function saveToAzure(meetingUuid, streamId) {
  console.log(`📁 Preparing to upload files for meeting: ${meetingUuid}, stream: ${streamId}`);
  
  const blobServiceClient = getBlobServiceClient();
  
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

  const containerName = 'rtms';
  const containerClient = blobServiceClient.getContainerClient(containerName);
  
  try {
    const exists = await containerClient.exists();
    if (!exists) {
      console.log(`🆕 Container ${containerName} not found. Creating...`);
      await containerClient.create();
    } else {
      console.log(`✅ Container ${containerName} exists.`);
    }
  } catch (error) {
    if (error.code === 'ENOTFOUND') {
      throw new Error(`Cannot connect to Azure Storage. The storage account name in your connection string may be incorrect. Error: ${error.message}`);
    }
    if (error.code === 'AuthenticationFailed' || error.statusCode === 403) {
      throw new Error(`Azure authentication failed. Check your AccountKey in AZURE_STORAGE_CONNECTION_STRING. Error: ${error.message}`);
    }
    throw new Error(`Failed to access Azure container: ${error.message}`);
  }

  let successCount = 0;
  let failCount = 0;

  for (const file of files) {
    const localFilePath = path.join(folderPath, file);
    console.log(`📄 Processing file: ${file}`);

    const blobName = `${safeMeetingUuid}/${safeStreamId}/${file}`;
    const contentType = getContentTypeByExtension(file);

    console.log(`🚀 Uploading ${file} to Azure container ${containerName} as blob: ${blobName}`);

    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const uploadStream = fs.createReadStream(localFilePath);

    const uploadOptions = {
      blobHTTPHeaders: { blobContentType: contentType }
    };

    try {
      await blockBlobClient.uploadStream(uploadStream, undefined, undefined, uploadOptions);
      console.log(`✅ Successfully uploaded: ${blobName} (Content-Type: ${contentType})`);
      successCount++;
    } catch (error) {
      console.error(`❌ Failed to upload ${file}:`, error.message);
      failCount++;
    }
  }

  console.log(`🏁 Finished Azure upload for meeting ${meetingUuid}: ${successCount} succeeded, ${failCount} failed`);
  
  if (failCount > 0) {
    throw new Error(`${failCount} file(s) failed to upload to Azure`);
  }
}
