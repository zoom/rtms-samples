import net from 'net';
import { URL } from 'url';
import { FileLogger } from '../utils/FileLogger.js';

const REGION_MAP = {
  'SJC': 'US West (N. California)',
  'IAD': 'US East (N. Virginia)',
  'AMS': 'Europe (Amsterdam)',
  'FRA': 'Europe (Frankfurt)',
  'MEL': 'Asia Pacific (Melbourne)',
  'SYD': 'Asia Pacific (Sydney)',
  'YYZ': 'Canada (Central)',
  'SIN': 'Asia Pacific (Singapore)',
  'NRT': 'Asia Pacific (Tokyo)',
  'HKG': 'Asia Pacific (Hong Kong)'
};

export class ServerPinger {
  static async ping(url) {
    try {
      const parsedUrl = new URL(url);
      const port = parsedUrl.port || (parsedUrl.protocol === 'wss:' || parsedUrl.protocol === 'https:' ? 443 : 80);
      const hostname = parsedUrl.hostname;

      // Detect region
      let location = 'Unknown Location';
      for (const [code, name] of Object.entries(REGION_MAP)) {
        if (hostname.toUpperCase().includes(code)) {
          location = name;
          break;
        }
      }
      FileLogger.log(`[ServerPinger] Server Location: ${location}`);

      FileLogger.log(`[ServerPinger] Pinging ${hostname}:${port}...`);
      const startPing = Date.now();
      
      return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(5000);
        
        socket.connect(port, hostname, () => {
          const rtt = Date.now() - startPing;
          FileLogger.log(`[ServerPinger] TCP Ping to ${hostname}:${port} RTT: ${rtt}ms (connected)`);
          socket.destroy();
          resolve(rtt);
        });

        socket.on('error', (err) => {
          FileLogger.error(`[ServerPinger] TCP Ping to ${hostname}:${port} failed: ${err.message}`);
          socket.destroy();
          resolve(-1);
        });

        socket.on('timeout', () => {
          FileLogger.error(`[ServerPinger] TCP Ping to ${hostname}:${port} timeout (5s)`);
          socket.destroy();
          resolve(-1);
        });
      });
    } catch (err) {
      FileLogger.error(`[ServerPinger] Error parsing URL or setting up ping: ${err.message}`);
      return false;
    }
  }
}
