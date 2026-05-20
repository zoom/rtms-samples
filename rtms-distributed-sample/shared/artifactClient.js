import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { HttpError } from './errors.js';
import { postJson } from './http.js';
import { retryWithBackoff } from './retry.js';

export async function uploadArtifact(artifactStorageUrl, artifact, options = {}) {
  if (!artifactStorageUrl) {
    throw new Error('artifactStorageUrl is required');
  }

  return postJson(`${artifactStorageUrl.replace(/\/+$/, '')}/artifacts`, artifact, {
    timeoutMs: options.timeoutMs || 30000,
    retryPolicy: options.retryPolicy || {
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 5000
    }
  });
}

export async function uploadArtifactFile(artifactStorageUrl, options = {}) {
  if (!artifactStorageUrl) {
    throw new Error('artifactStorageUrl is required');
  }

  const filePath = requireValue(options.filePath, 'filePath');
  const streamId = requireValue(options.streamId, 'streamId');
  const artifactType = requireValue(options.artifactType, 'artifactType');
  const fileName = options.fileName || path.basename(filePath);
  const contentType = options.contentType || inferContentType(fileName);
  const query = new URLSearchParams();

  for (const [name, value] of [
    ['regionCode', options.regionCode],
    ['productType', options.productType],
    ['rtmsId', options.rtmsId]
  ]) {
    if (value !== undefined && value !== null && value !== '') {
      query.set(name, String(value));
    }
  }

  const url = [
    artifactStorageUrl.replace(/\/+$/, ''),
    'streams',
    encodeURIComponent(streamId),
    'artifacts',
    encodeURIComponent(artifactType),
    encodeURIComponent(fileName)
  ].join('/') + (query.size ? `?${query.toString()}` : '');

  return retryWithBackoff(() => uploadArtifactFileOnce(url, filePath, {
    contentType,
    metadata: options.metadata,
    timeoutMs: options.timeoutMs
  }), {
    maxAttempts: options.retryPolicy?.maxAttempts || 3,
    baseDelayMs: options.retryPolicy?.baseDelayMs || 500,
    maxDelayMs: options.retryPolicy?.maxDelayMs || 5000,
    label: `PUT artifact ${fileName}`
  });
}

async function uploadArtifactFileOnce(url, filePath, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  const headers = {
    'content-type': options.contentType || 'application/octet-stream'
  };

  if (options.metadata) {
    headers['x-rtms-artifact-metadata'] = JSON.stringify(options.metadata);
  }

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: fs.createReadStream(filePath),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(`PUT ${url} failed`, {
        method: 'PUT',
        url,
        status: response.status,
        body: text
      });
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timeout);
  }
}

function inferContentType(fileName = '') {
  const lower = String(fileName).toLowerCase();
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.vtt')) return 'text/vtt';
  if (lower.endsWith('.srt')) return 'application/x-subrip';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.jsonl')) return 'application/jsonl';
  if (lower.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

function requireValue(value, name) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}
