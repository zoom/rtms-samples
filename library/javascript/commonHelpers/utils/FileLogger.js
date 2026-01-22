import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Path to logs directory: samples/print-audio/logs
const LOG_DIR = path.join(__dirname, '../../logs'); 

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getLogFilePath() {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const hour = now.getHours().toString().padStart(2, '0');
  const filename = `rtms_${dateStr}_${hour}.log`;
  return path.join(LOG_DIR, filename);
}

export class FileLogger {
  static consoleEnabled = true;

  static setConsoleOutput(enabled) {
    this.consoleEnabled = !!enabled;
  }

  static log(...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => 
      (typeof arg === 'object' && arg !== null) ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    const logMessage = `[${timestamp}] ${message}`;
    
    if (this.consoleEnabled) {
      console.log(logMessage); // Keep console output with timestamp
    }
    
    fs.appendFile(getLogFilePath(), logMessage + '\n', (err) => {
      if (err) console.error('Failed to write to log file:', err);
    });
  }
  
  static error(...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => 
      (typeof arg === 'object' && arg !== null) ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    const logMessage = `[${timestamp}] [ERROR] ${message}`;
    
    if (this.consoleEnabled) {
      console.error(logMessage); // Keep console output with timestamp
    }
    
    fs.appendFile(getLogFilePath(), logMessage + '\n', (err) => {
      if (err) console.error('Failed to write to log file:', err);
    });
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
      console.warn(logMessage); // Keep console output with timestamp
    }
    
    fs.appendFile(getLogFilePath(), logMessage + '\n', (err) => {
      if (err) console.error('Failed to write to log file:', err);
    });
  }
}
