import fs from 'fs';
import path from 'path';

let logDir = null;

/**
 * Log levels: off < error < warn < info < debug
 */
const LOG_LEVELS = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
};

/**
 * FileLogger with configurable log levels
 * Default: 'off' for cleaner output in production
 * 
 * @example
 * FileLogger.setLevel('info');  // Enable info, warn, error
 * FileLogger.setLevel('off');   // Disable all logging
 * FileLogger.setLevel('debug'); // Enable all logging
 */
export class FileLogger {
  /** Current log level (default: 'off' for clean output) */
  static level = 'off';
  /** Whether to output to console */
  static consoleEnabled = true;
  /** Whether to write to file */
  static fileEnabled = true;
  
  static logBuffer = [];
  static flushTimer = null;
  static flushInterval = 100; // Flush every 100ms
  static maxBufferSize = 50; // Or when buffer reaches 50 entries
  static isShuttingDown = false;

  static getLogFilePath() {
    if (!logDir) return null;
    
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const hour = now.getHours().toString().padStart(2, '0');
    const filename = `rtms_${dateStr}_${hour}.log`;
    return path.join(logDir, filename);
  }

  static setLogDir(dir) {
    logDir = dir;
    if (logDir && !fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  static {
    // Setup process exit handler to flush remaining logs
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

  /**
   * Set the logging level
   * @param {'off'|'error'|'warn'|'info'|'debug'} level
   */
  static setLevel(level) {
    if (level in LOG_LEVELS) {
      this.level = level;
      // Enable console when logging is on
      this.consoleEnabled = level !== 'off';
    }
  }

  /**
   * Check if a given level should be logged
   * @param {'error'|'warn'|'info'|'debug'} level
   */
  static shouldLog(level) {
    return LOG_LEVELS[level] <= LOG_LEVELS[this.level];
  }

  static setConsoleOutput(enabled) {
    this.consoleEnabled = !!enabled;
  }

  static setFileOutput(enabled) {
    this.fileEnabled = !!enabled;
  }

  static addToBuffer(logMessage) {
    if (!this.fileEnabled) return;
    
    this.logBuffer.push(logMessage);

    // Flush if buffer is full
    if (this.logBuffer.length >= this.maxBufferSize) {
      this.flush();
      return;
    }

    // Setup flush timer if not already running
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

    const logFilePath = this.getLogFilePath();
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

    const logFilePath = this.getLogFilePath();
    if (!logFilePath) return;

    const logsToWrite = this.logBuffer.join('');
    this.logBuffer = [];

    try {
      fs.appendFileSync(logFilePath, logsToWrite);
    } catch (err) {
      console.error('Failed to write to log file:', err);
    }
  }

  static formatMessage(...args) {
    return args.map(arg =>
      (typeof arg === 'object' && arg !== null) ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
  }

  /**
   * Debug level logging (most verbose)
   */
  static debug(...args) {
    if (!this.shouldLog('debug')) return;
    
    const timestamp = new Date().toISOString();
    const message = this.formatMessage(...args);
    const logMessage = `[${timestamp}] [DEBUG] ${message}`;

    if (this.consoleEnabled) {
      console.log(logMessage);
    }
    this.addToBuffer(logMessage + '\n');
  }

  /**
   * Info level logging
   */
  static info(...args) {
    if (!this.shouldLog('info')) return;
    
    const timestamp = new Date().toISOString();
    const message = this.formatMessage(...args);
    const logMessage = `[${timestamp}] ${message}`;

    if (this.consoleEnabled) {
      console.log(logMessage);
    }
    this.addToBuffer(logMessage + '\n');
  }

  /**
   * General log (alias for info)
   */
  static log(...args) {
    this.info(...args);
  }

  /**
   * Warning level logging
   */
  static warn(...args) {
    if (!this.shouldLog('warn')) return;
    
    const timestamp = new Date().toISOString();
    const message = this.formatMessage(...args);
    const logMessage = `[${timestamp}] [WARN] ${message}`;

    if (this.consoleEnabled) {
      console.warn(logMessage);
    }
    this.addToBuffer(logMessage + '\n');
  }

  /**
   * Error level logging (always logged unless 'off')
   */
  static error(...args) {
    if (!this.shouldLog('error')) return;
    
    const timestamp = new Date().toISOString();
    const message = this.formatMessage(...args);
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
}

export default FileLogger;
