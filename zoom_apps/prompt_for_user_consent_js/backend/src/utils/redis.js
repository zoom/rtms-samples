const redis = require('redis');
const config = require('../config');

let redisClient = null;

async function getRedisClient() {
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  try {
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
    const data = await client.get(key);

    if (!data) {
      // Return default state if no data exists
      return {
        meetingId,
        participants: [],
        rtmsStatus: 'stopped',
        rtmsPausedReason: null,
        unanimousConsent: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }

    return JSON.parse(data);
  } catch (error) {
    console.error('Error getting consent state:', error);
    throw error;
  }
}

async function saveConsentState(meetingId, state) {
  try {
    const client = await getRedisClient();
    const key = `consent:${meetingId}`;

    state.updatedAt = new Date().toISOString();

    await client.set(key, JSON.stringify(state), {
      EX: 24 * 60 * 60 // 24 hours TTL
    });

    return state;
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
  getConsentState,
  saveConsentState,
  deleteConsentState
};
