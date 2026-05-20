import fs from 'fs';
import path from 'path';

export function readSecretValue(name, options = {}) {
  const env = options.env || process.env;
  const secretDir = options.secretDir || env.RTMS_SECRET_DIR || '/var/run/rtms/secrets';

  if (env[name]) return env[name];

  const fileEnvName = `${name}_FILE`;
  if (env[fileEnvName]) {
    return readSecretFile(env[fileEnvName], options);
  }

  const mountedPath = path.join(secretDir, name);
  if (fs.existsSync(mountedPath)) {
    return readSecretFile(mountedPath, options);
  }

  return options.defaultValue || '';
}

export function readZoomCredentials(options = {}) {
  const env = options.env || process.env;
  return {
    meeting: {
      clientId: readSecretValue('ZOOM_CLIENT_ID', { env }),
      clientSecret: readSecretValue('ZOOM_CLIENT_SECRET', { env }),
      secretToken: readSecretValue('ZOOM_SECRET_TOKEN', { env })
    },
    webinar: {
      clientId: readSecretValue('ZOOM_CLIENT_ID', { env }),
      clientSecret: readSecretValue('ZOOM_CLIENT_SECRET', { env }),
      secretToken: readSecretValue('ZOOM_SECRET_TOKEN', { env })
    },
    videoSdk: {
      clientId: readSecretValue('VIDEO_CLIENT_ID', { env }),
      clientSecret: readSecretValue('VIDEO_CLIENT_SECRET', { env }),
      secretToken: readSecretValue('VIDEO_SECRET_TOKEN', { env })
    }
  };
}

function readSecretFile(filePath, options = {}) {
  const value = fs.readFileSync(filePath, 'utf8');
  return options.preserveWhitespace ? value : value.trimEnd();
}
