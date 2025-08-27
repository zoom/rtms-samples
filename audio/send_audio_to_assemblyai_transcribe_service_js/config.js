import dotenv from 'dotenv';
dotenv.config();

const requiredVars = ['ZM_CLIENT_ID', 'ZM_CLIENT_SECRET'];

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

  clientId: process.env.ZM_CLIENT_ID,
  clientSecret: process.env.ZM_CLIENT_SECRET,

  s2sClientId: process.env.ZM_S2S_CLIENT_ID || null,
  s2sClientSecret: process.env.ZM_S2S_CLIENT_SECRET || null,
  accountId: process.env.ZM_ACCOUNT_ID || null,

  zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
  ws_url: process.env.WS_URL,
};
