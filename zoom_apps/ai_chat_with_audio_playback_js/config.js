import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

export function parseWakeWords(raw) {
  const source = typeof raw === 'string' && raw.trim()
    ? raw
    : 'hey ai,okay ai,ok ai,assistant';
  return source
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function loadConfig(env = process.env, { validate = true } = {}) {
  if (validate) {
    const requiredVars = ['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET'];
    for (const key of requiredVars) {
      if (!env[key]) {
        throw new Error(`Missing required environment variable: ${key}`);
      }
    }
  }

  return {
    port: Number(env.PORT) || 3000,
    mode: env.MODE || 'webhook',
    zoomWSURLForEvents: env.zoomWSURLForEvents || '',
    webhookPath: env.WEBHOOK_PATH || '/webhook',

    clientId: env.ZOOM_CLIENT_ID || '',
    clientSecret: env.ZOOM_CLIENT_SECRET || '',
    zoomSecretToken: env.ZOOM_SECRET_TOKEN || '',

    s2sClientId: env.ZOOM_S2S_CLIENT_ID || null,
    s2sClientSecret: env.ZOOM_S2S_CLIENT_SECRET || null,
    accountId: env.ZOOM_ACCOUNT_ID || null,

    frontendWssUrl: env.FRONTEND_WSS_URL_TO_CONNECT_TO || '',
    frontendWssAuthToken: env.FRONTEND_WSS_AUTH_TOKEN || '',
    allowPreRtmsRegistration: env.ALLOW_PRE_RTMS_REGISTRATION === 'true',

    defaultResponseMode: ['wake_word', 'push_to_talk', 'auto'].includes(env.DEFAULT_RESPONSE_MODE)
      ? env.DEFAULT_RESPONSE_MODE
      : 'wake_word',
    defaultWakeWords: parseWakeWords(env.DEFAULT_WAKE_WORDS),
    echoCooldownMs: Number(env.ECHO_COOLDOWN_MS) || 2500,
    echoWindowMs: Number(env.ECHO_WINDOW_MS) || 12000,
    maxHistoryMessages: Number(env.MAX_HISTORY_MESSAGES) || 20
  };
}

export const config = loadConfig(process.env, { validate: false });
