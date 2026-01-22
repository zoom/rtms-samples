import dotenv from 'dotenv';
dotenv.config();

const requiredVars = ['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET'];

for (const key of requiredVars) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const config = {
  port: process.env.PORT || 3000,

  mode: process.env.MODE || 'webhook',
  zoomWSURLForEvents: process.env.zoomWSURLForEvents || '',
  
  webhookPath: process.env.WEBHOOK_PATH || '/webhook',

  clientId: process.env.ZOOM_CLIENT_ID,
  clientSecret: process.env.ZOOM_CLIENT_SECRET,

  s2sClientId: process.env.ZOOM_S2S_CLIENT_ID || null,
  s2sClientSecret: process.env.ZOOM_S2S_CLIENT_SECRET || null,
  accountId: process.env.ZOOM_ACCOUNT_ID || null,

  zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
  frontendWssUrl: process.env.FRONTEND_WSS_URL_TO_CONNECT_TO,
};
