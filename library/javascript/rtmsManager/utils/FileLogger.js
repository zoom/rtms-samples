import fs from 'fs';
import path from 'path';

let logDir = null;
let loggingEnabled = false;

function ensureLogDir() {
  if (logDir && !fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

function getLogFilePath() {
  if (!logDir) return null;
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const hour = now.getHours().toString().padStart(2, '0');
  const filename = `rtms_${dateStr}_${hour}.log`;
  return path.join(logDir, filename);
}

export class FileLogger {
  static consoleEnabled = true;
  static logBuffer = [];
  static flushTimer = null;
  static flushInterval = 100;
  static maxBufferSize = 50;
  static isShuttingDown = false;

  static {
    if (typeof process !== 'undefined') {
      process.on('exit', () => {
        this.isShuttingDown = true;
        this.flushSync();
      });
      process.on('SIGINT', () => {
        this.isShuttingDown = true;
        this.flushSync();
        process.exit(0);
      });
      process.on('SIGTERM', () => {
        this.isShuttingDown = true;
        this.flushSync();
        process.exit(0);
      });
    }
  }

  static configure(options = {}) {
    if (options.logDir) {
      logDir = options.logDir;
      ensureLogDir();
    }
    if (typeof options.enabled === 'boolean') {
      loggingEnabled = options.enabled;
    }
    if (typeof options.console === 'boolean') {
      this.consoleEnabled = options.console;
    }
  }

  static setConsoleOutput(enabled) {
    this.consoleEnabled = !!enabled;
  }

  static addToBuffer(logMessage) {
    if (!loggingEnabled || !logDir) return;
    
    this.logBuffer.push(logMessage);

    if (this.logBuffer.length >= this.maxBufferSize) {
      this.flush();
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush();
      }, this.flushInterval);
    }
  }

  static flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.logBuffer.length === 0) return;
    
    const logFilePath = getLogFilePath();
    if (!logFilePath) return;

    const logsToWrite = this.logBuffer.join('');
    this.logBuffer = [];

    fs.appendFile(logFilePath, logsToWrite, (err) => {
      if (err) console.error('Failed to write to log file:', err);
    });
  }

  static flushSync() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.logBuffer.length === 0) return;
    
    const logFilePath = getLogFilePath();
    if (!logFilePath) return;

    const logsToWrite = this.logBuffer.join('');
    this.logBuffer = [];

    // Synchronous write for critical situations (process exit)
    try {
      fs.appendFileSync(getLogFilePath(), logsToWrite);
    } catch (err) {
      console.error('Failed to write to log file:', err);
    }
  }

  static log(...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(arg =>
      (typeof arg === 'object' && arg !== null) ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    const logMessage = `[${timestamp}] ${message}`;

    if (this.consoleEnabled) {
      console.log(logMessage);
    }

    this.addToBuffer(logMessage + '\n');
  }

  static error(...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(arg =>
      (typeof arg === 'object' && arg !== null) ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    const logMessage = `[${timestamp}] [ERROR] ${message}`;

    if (this.consoleEnabled) {
      console.error(logMessage);
    }

    // For errors, write immediately if shutting down, otherwise batch
    if (this.isShuttingDown) {
      this.logBuffer.push(logMessage + '\n');
      this.flushSync();
    } else {
      this.addToBuffer(logMessage + '\n');
    }
  }

  static info(...args) {
    this.log(...args);
  }

  static warn(...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(arg =>
      (typeof arg === 'object' && arg !== null) ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    const logMessage = `[${timestamp}] [WARN] ${message}`;

    if (this.consoleEnabled) {
      console.warn(logMessage);
    }

    this.addToBuffer(logMessage + '\n');
  }
}
