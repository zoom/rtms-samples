import fetch from 'node-fetch';
import { config } from './config.js';

let cachedToken = null;
let tokenExpiry = 0;

/**
 * Fetches a new Zoom Server-to-Server access token using account_credentials grant.
 */
async function getAccessToken() {
  const { s2sClientId, s2sClientSecret, accountId } = config;

  if (!s2sClientId || !s2sClientSecret || !accountId) {
    throw new Error('S2S Zoom API is not configured. Missing s2sClientId, s2sClientSecret, or accountId.');
  }

  const creds = Buffer.from(`${s2sClientId}:${s2sClientSecret}`).toString('base64');
  const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch S2S Zoom token: ${errorText}`);
  }

  const result = await response.json();
  cachedToken = result.access_token;
  tokenExpiry = Date.now() + result.expires_in * 1000 - 5000; // 5s buffer

  return cachedToken;
}

/**
 * Makes an authorized request to the Zoom API using S2S token.
 * @param {Object} options
 * @param {string} options.url - Full Zoom API endpoint
 * @param {string} [options.method='GET'] - HTTP method
 * @param {Object|null} [options.data=null] - Optional body for POST/PATCH
 * @returns {Promise<any>} Parsed JSON response
 */
export async function s2sZoomApiRequest({ url, method = 'GET', data = null }) {
  if (!config.s2sClientId || !config.s2sClientSecret || !config.accountId) {
    throw new Error('S2S Zoom API request blocked: missing credentials.');
  }

  const token = await getAccessToken();

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const options = {
    method,
    headers,
  };

  if (data && method !== 'GET') {
    options.body = JSON.stringify(data);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Zoom API error (${response.status}): ${errorText}`);
  }

  return await response.json();
}
