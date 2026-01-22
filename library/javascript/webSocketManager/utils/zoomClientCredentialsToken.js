import fetch from 'node-fetch';

/**
 * Fetches Zoom client_credentials access token for Event WebSocket.
 * @param {string} clientId - Zoom Client ID
 * @param {string} clientSecret - Zoom Client Secret
 * @returns {Promise<string>} Access token
 */
export async function getAccessTokenForEventWebsocket(clientId, clientSecret) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch('https://zoom.us/oauth/token?grant_type=client_credentials', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch Event WS token: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
}
