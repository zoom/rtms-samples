import crypto from 'crypto';

export function generateRTMSSignature(rtmsId, streamId, clientId, clientSecret) {
  
  const message = `${clientId},${rtmsId},${streamId}`;
  return crypto.createHmac('sha256', clientSecret).update(message).digest('hex');
}
