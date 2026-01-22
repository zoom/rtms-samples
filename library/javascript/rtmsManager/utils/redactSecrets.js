const SECRET_KEYS = [
  'clientId',
  'clientSecret', 
  'zoomSecretToken',
  'videoSecretToken',
  'accountId',
  'secret',
  'token',
  'apiKey',
  'password'
];

export function redactSecrets(obj) {
  return JSON.parse(JSON.stringify(obj, (key, value) => 
    SECRET_KEYS.some(k => key.toLowerCase().includes(k.toLowerCase())) && value 
      ? '[REDACTED]' 
      : value
  ));
}
