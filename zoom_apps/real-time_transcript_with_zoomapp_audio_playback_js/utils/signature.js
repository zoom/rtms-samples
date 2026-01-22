import crypto from 'crypto';

export function generateSignature(meetingUuid, streamId, clientId, clientSecret) {
  const message = `${clientId},${meetingUuid},${streamId}`;
  return crypto.createHmac('sha256', clientSecret).update(message).digest('hex');
}
