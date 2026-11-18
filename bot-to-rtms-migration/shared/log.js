/** One JSON line per event. IDs and state names only: never secrets or raw media. */
export function createLogger(name, sink = console) {
  const write = (level, message, fields = {}) => {
    sink.log(JSON.stringify({ ts: new Date().toISOString(), level, name, message, ...fields }));
  };
  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields)
  };
}

export const silentLogger = { info() {}, warn() {}, error() {} };
