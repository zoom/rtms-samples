const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

// Validate required environment variables
function validateEnv() {
  const required = [
    'ZOOM_APP_CLIENT_ID',
    'ZOOM_APP_CLIENT_SECRET',
    'SESSION_SECRET',
    'REDIS_ENCRYPTION_KEY'
  ];

  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error('Missing required environment variables:');
    missing.forEach(key => console.error(`  - ${key}`));
    console.error('\nPlease check your .env file');
    process.exit(1);
  }

  // Validate encryption key length (must be 32 characters for AES-256)
  if (process.env.REDIS_ENCRYPTION_KEY.length !== 32) {
    console.error('REDIS_ENCRYPTION_KEY must be exactly 32 characters');
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
  zoomAppClientId: process.env.ZOOM_APP_CLIENT_ID,
  zoomAppClientSecret: process.env.ZOOM_APP_CLIENT_SECRET,
  zoomAppRedirectUri: process.env.ZOOM_APP_REDIRECT_URI,

  // Security
  sessionSecret: process.env.SESSION_SECRET,
  redisEncryptionKey: process.env.REDIS_ENCRYPTION_KEY,

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // Zoom Webhook
  zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,

  // RTMS
  rtmsPort: process.env.RTMS_PORT || 3002,

  // Development
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production'
};

module.exports = config;
