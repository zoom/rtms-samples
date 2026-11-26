const config = require('../config');
const { encrypt, decrypt, isEncryptionEnabled, looksEncrypted } = require('./encryption');

let redisClient = null;
let warnedUnencrypted = false;

function createDefaultConsentState(meetingId) {
  const now = new Date().toISOString();
  return {
    meetingId,
    participants: [],
    policyMode: 'unanimous', // 'unanimous' | 'redact'
    rtmsStatus: 'stopped', // 'stopped' | 'running' | 'paused'
    rtmsPausedReason: null,
    unanimousConsent: false,
    auditTrail: [],
    createdAt: now,
    updatedAt: now
  };
}

function normalizeConsentState(meetingId, state) {
  const base = createDefaultConsentState(meetingId);
  return {
    ...base,
    ...state,
    meetingId: state?.meetingId || meetingId,
    participants: Array.isArray(state?.participants) ? state.participants : [],
    policyMode: state?.policyMode === 'redact' ? 'redact' : 'unanimous',
    auditTrail: Array.isArray(state?.auditTrail) ? state.auditTrail : []
  };
}

function setRedisClient(client) {
  redisClient = client;
}

async function getRedisClient() {
  if (redisClient && (redisClient.isOpen === undefined || redisClient.isOpen)) {
    return redisClient;
  }

  try {
    const redis = require('redis');
    redisClient = redis.createClient({
      url: config.redisUrl
    });

    redisClient.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });

    redisClient.on('connect', () => {
      console.log('Redis client connected');
    });

    await redisClient.connect();
    return redisClient;
  } catch (error) {
    console.error('Failed to connect to Redis:', error);
    throw error;
  }
}

async function getConsentState(meetingId) {
  try {
    const client = await getRedisClient();
    const key = `consent:${meetingId}`;
    const rawData = await client.get(key);

    if (!rawData) {
      return createDefaultConsentState(meetingId);
    }

    let jsonString = rawData;
    if (looksEncrypted(rawData)) {
      if (!isEncryptionEnabled()) {
        throw new Error('Encrypted consent state found in Redis but ENCRYPTION_KEY / REDIS_ENCRYPTION_KEY is not configured');
      }
      jsonString = decrypt(rawData);
    }

    return normalizeConsentState(meetingId, JSON.parse(jsonString));
  } catch (error) {
    console.error('Error getting consent state:', error);
    throw error;
  }
}

async function saveConsentState(meetingId, state) {
  try {
    const client = await getRedisClient();
    const key = `consent:${meetingId}`;

    const normalized = normalizeConsentState(meetingId, state);
    normalized.updatedAt = new Date().toISOString();

    const serialized = JSON.stringify(normalized);
    let valueToStore = serialized;

    if (isEncryptionEnabled()) {
      valueToStore = encrypt(serialized);
    } else if (!warnedUnencrypted) {
      warnedUnencrypted = true;
      console.warn('ENCRYPTION_KEY / REDIS_ENCRYPTION_KEY not configured; storing consent state in Redis without encryption');
    }

    await client.set(key, valueToStore, {
      EX: 24 * 60 * 60 // 24 hours TTL
    });

    return normalized;
  } catch (error) {
    console.error('Error saving consent state:', error);
    throw error;
  }
}

async function deleteConsentState(meetingId) {
  try {
    const client = await getRedisClient();
    const key = `consent:${meetingId}`;
    await client.del(key);
  } catch (error) {
    console.error('Error deleting consent state:', error);
    throw error;
  }
}

module.exports = {
  getRedisClient,
  setRedisClient,
  createDefaultConsentState,
  getConsentState,
  saveConsentState,
  deleteConsentState
};
