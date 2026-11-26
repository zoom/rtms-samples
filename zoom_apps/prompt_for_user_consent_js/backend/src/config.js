const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '../../.env') });
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

function getEncryptionKeyValue() {
  return process.env.ENCRYPTION_KEY || process.env.REDIS_ENCRYPTION_KEY || '';
}

function isValidEncryptionKey(key) {
  if (!key) return true; // Optional: clean fallback to unencrypted storage when unset
  return Buffer.byteLength(key, 'utf8') === 32 || /^[0-9a-fA-F]{64}$/.test(key);
}

// Validate required environment variables
function validateEnv() {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  const required = [
    'ZOOM_APP_CLIENT_ID',
    'ZOOM_APP_CLIENT_SECRET',
    'SESSION_SECRET'
  ];

  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error('Missing required environment variables:');
    missing.forEach(key => console.error(`  - ${key}`));
    console.error('\nPlease check your .env file');
    process.exit(1);
  }

  const encryptionKey = getEncryptionKeyValue();
  if (encryptionKey && !isValidEncryptionKey(encryptionKey)) {
    console.error('ENCRYPTION_KEY / REDIS_ENCRYPTION_KEY must be 32 UTF-8 bytes or 64 hex characters');
    process.exit(1);
  }
}

validateEnv();

const config = {
  // Server
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:3000',

  // Zoom App Credentials
  zoomAppClientId: process.env.ZOOM_APP_CLIENT_ID || '',
  zoomAppClientSecret: process.env.ZOOM_APP_CLIENT_SECRET || '',
  zoomAppRedirectUri: process.env.ZOOM_APP_REDIRECT_URI || '',

  // Security
  sessionSecret: process.env.SESSION_SECRET || 'test-session-secret',
  encryptionKey: getEncryptionKeyValue(),
  redisEncryptionKey: getEncryptionKeyValue(),
  internalWebhookToken: process.env.INTERNAL_WEBHOOK_TOKEN || '',
  allowUnverifiedDevAuth:
    process.env.NODE_ENV !== 'production' &&
    process.env.ALLOW_UNVERIFIED_DEV_AUTH === 'true',

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // Zoom Webhook
  zoomSecretToken: process.env.ZOOM_SECRET_TOKEN || '',

  // RTMS
  rtmsPort: process.env.RTMS_PORT || 3002,
  rtmsServerUrl: process.env.RTMS_SERVER_URL || 'http://localhost:3002',

  // Development
  isDevelopment: (process.env.NODE_ENV || 'development') === 'development',
  isProduction: process.env.NODE_ENV === 'production'
};

module.exports = config;
