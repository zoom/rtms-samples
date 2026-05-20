import fs from 'fs';
import os from 'os';
import path from 'path';
import { readSecretValue, readZoomCredentials } from '../shared/secretConfig.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtms-secrets-'));

try {
  fs.writeFileSync(path.join(tempDir, 'ZOOM_CLIENT_ID'), 'mounted-client-id\n', 'utf8');
  fs.writeFileSync(path.join(tempDir, 'ZOOM_CLIENT_SECRET'), 'mounted-client-secret\n', 'utf8');
  fs.writeFileSync(path.join(tempDir, 'ZOOM_SECRET_TOKEN'), 'mounted-secret-token\n', 'utf8');
  fs.writeFileSync(path.join(tempDir, 'VIDEO_CLIENT_ID'), 'video-client-id\n', 'utf8');
  fs.writeFileSync(path.join(tempDir, 'VIDEO_CLIENT_SECRET'), 'video-client-secret\n', 'utf8');
  fs.writeFileSync(path.join(tempDir, 'VIDEO_SECRET_TOKEN'), 'video-secret-token\n', 'utf8');

  const mountedEnv = { RTMS_SECRET_DIR: tempDir };
  assert(readSecretValue('ZOOM_CLIENT_ID', { env: mountedEnv }) === 'mounted-client-id', 'mounted secret file was not read');
  console.log('PASS mounted_secret_file_read');

  const explicitFile = path.join(tempDir, 'explicit-secret');
  fs.writeFileSync(explicitFile, 'explicit-value\n', 'utf8');
  assert(readSecretValue('EXPLICIT_SECRET', { env: { EXPLICIT_SECRET_FILE: explicitFile } }) === 'explicit-value', 'explicit _FILE secret was not read');
  console.log('PASS explicit_file_secret_read');

  assert(readSecretValue('ZOOM_CLIENT_ID', {
    env: {
      ZOOM_CLIENT_ID: 'env-client-id',
      RTMS_SECRET_DIR: tempDir
    }
  }) === 'env-client-id', 'env value should win over mounted file');
  console.log('PASS env_value_precedence');

  const credentials = readZoomCredentials({ env: mountedEnv });
  assert(credentials.meeting.clientId === 'mounted-client-id', 'meeting client id mismatch');
  assert(credentials.meeting.clientSecret === 'mounted-client-secret', 'meeting client secret mismatch');
  assert(credentials.meeting.secretToken === 'mounted-secret-token', 'meeting secret token mismatch');
  assert(credentials.videoSdk.clientId === 'video-client-id', 'video client id mismatch');
  console.log('PASS zoom_credentials_loaded');

  console.log('09 secret config tester passed: 4/4');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
