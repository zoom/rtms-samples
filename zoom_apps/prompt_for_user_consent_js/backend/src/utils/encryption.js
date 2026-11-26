const crypto = require('crypto');
const config = require('../config');

const ALGORITHM = 'aes-256-cbc';
const ENCRYPTED_PREFIX = 'enc:v1:';

function resolveKey(overrideKey) {
  const rawKey = overrideKey !== undefined
    ? overrideKey
    : (process.env.ENCRYPTION_KEY || process.env.REDIS_ENCRYPTION_KEY || config.encryptionKey || '');

  if (!rawKey) {
    return null;
  }

  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }

  const utf8Buf = Buffer.from(rawKey, 'utf8');
  if (utf8Buf.length === 32) {
    return utf8Buf;
  }

  throw new Error('ENCRYPTION_KEY / REDIS_ENCRYPTION_KEY must be 32 UTF-8 bytes or 64 hex characters');
}

function isEncryptionEnabled(overrideKey) {
  return resolveKey(overrideKey) !== null;
}

/**
 * Encrypt data using AES-256-CBC
 */
function encrypt(text, overrideKey) {
  const key = resolveKey(overrideKey);
  if (!key) {
    return text;
  }

  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(String(text), 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return `${ENCRYPTED_PREFIX}${iv.toString('hex')}:${encrypted}`;
  } catch (error) {
    console.error('Encryption error:', error);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Decrypt data using AES-256-CBC
 * Supports both prefixed (`enc:v1:iv:cipher`) and legacy (`iv:cipher`) formats.
 */
function decrypt(text, overrideKey) {
  const key = resolveKey(overrideKey);
  if (!key) {
    return text;
  }

  try {
    const payload = String(text).startsWith(ENCRYPTED_PREFIX)
      ? String(text).slice(ENCRYPTED_PREFIX.length)
      : String(text);
    const parts = payload.split(':');
    if (parts.length < 2) {
      throw new Error('Invalid encrypted payload format');
    }

    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = parts.join(':');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error);
    throw new Error('Failed to decrypt data');
  }
}

function looksEncrypted(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith(ENCRYPTED_PREFIX)) return true;
  return /^[0-9a-fA-F]{32}:[0-9a-fA-F]+$/.test(value);
}

module.exports = {
  encrypt,
  decrypt,
  isEncryptionEnabled,
  looksEncrypted
};
