import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { FileLogger } from './utils/FileLogger.js';

export class FrontendManager {
  constructor(options = {}) {
    this.config = options.config || {};
    this.app = options.app || null;
    this.logger = options.logger || FileLogger;
  }

  setup() {
    if (!this.app) {
      this.logger.warn('[FrontendManager] ⚠️ No Express app provided. Skipping frontend setup.');
      return;
    }

    if (this.config.serveStaticEnabled === false) {
      this.logger.info('[FrontendManager] ⏩ Static file serving disabled.');
      return;
    }

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    
    // Use configured views path or default to local public/views
    const viewsPath = this.config.viewsPath || path.join(__dirname, 'public/views');
    
    // Determine the public/static folder path
    // If viewsPath ends with 'views', use its parent as public path
    // Otherwise, if staticPath is explicitly set, use that
    // Otherwise, use the viewsPath's parent directory
    let publicPath = this.config.staticPath;
    if (!publicPath) {
      const viewsDirName = path.basename(viewsPath);
      if (viewsDirName === 'views') {
        publicPath = path.dirname(viewsPath);
      } else {
        // viewsPath might be pointing to 'public' directly (e.g., for projects with public/index.ejs)
        publicPath = viewsPath;
      }
    }

    // Serve static files from public folder (includes all subfolders like /lib, /css, /js)
    this.app.use(express.static(publicPath));
    this.logger.info(`[FrontendManager] 📁 Serving static files from: ${publicPath}`);
    
    this.app.set('view engine', 'ejs');
    this.app.set('views', viewsPath);

    this.app.get('/', (req, res) => {
      const host = req.headers.host || `localhost:${this.config.port}`;
      const wsPath = this.config.frontendWssPath || '/ws';
      
      // Determine WebSocket protocol:
      // 1. If request is secure (HTTPS) -> wss
      // 2. If x-forwarded-proto header says https -> wss
      // 3. If host is NOT localhost (production domain) -> default to wss
      // 4. Otherwise -> ws (local development)
      const isSecure = req.secure || 
                       req.headers['x-forwarded-proto'] === 'https' ||
                       (!host.includes('localhost') && !host.includes('127.0.0.1'));
      const protocol = isSecure ? 'wss' : 'ws';
      
      // Use configured URL if valid (starts with ws:// or wss://), otherwise auto-generate
      let wsUrl = this.config.frontendWssUrl;
      const isValidWsUrl = wsUrl && typeof wsUrl === 'string' && (wsUrl.startsWith('ws://') || wsUrl.startsWith('wss://'));
      
      if (!isValidWsUrl) {
        wsUrl = `${protocol}://${host}${wsPath}`;
        this.logger.info(`[FrontendManager] Auto-generated WebSocket URL: ${wsUrl}`);
      } else {
        this.logger.info(`[FrontendManager] Using configured WebSocket URL: ${wsUrl}`);
      }
      
      res.render('index', { websocketUrl: wsUrl });
    });

    this.logger.info(`[FrontendManager] 📱 Static views served at http://localhost:${this.config.port}`);
  }
}
