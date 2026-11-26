const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const config = require('./config');
const { getRedisClient } = require('./utils/redis');
const { securityHeaders, extractZoomContext } = require('./middleware/security');

// Import routes
const consentRoutes = require('./routes/consent');
const participantRoutes = require('./routes/participants');
const rtmsRoutes = require('./routes/rtms');
const zoomappRoutes = require('./routes/zoomapp');
const webhookRoutes = require('./routes/webhooks');

// Import services
const WebSocketServer = require('./services/WebSocketServer');

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: process.env.PUBLIC_URL || 'http://localhost:3001',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Initialize WebSocket service
const wsServer = new WebSocketServer(io);

// Pass WebSocket server to routes that need it
consentRoutes.setWebSocketServer(wsServer);
participantRoutes.setWebSocketServer(wsServer);
rtmsRoutes.setWebSocketServer(wsServer);
webhookRoutes.setWebSocketServer(wsServer);

// Base Middleware
app.use(cors({
  origin: process.env.PUBLIC_URL || 'http://localhost:3001',
  credentials: true
}));
app.use(express.json({
  verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); }
}));
app.use(express.urlencoded({ extended: true }));
app.use(securityHeaders);

// Session configuration (must be mounted BEFORE routes!)
async function setupSession() {
  let sessionMiddleware;
  try {
    const redisClient = await getRedisClient();

    sessionMiddleware = session({
      store: new RedisStore({ client: redisClient }),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 1000 * 60 * 60 // 1 hour
      }
    });

    console.log('Session middleware configured with Redis store');
  } catch (error) {
    console.error('Failed to setup Redis session store:', error);
    console.log('Falling back to MemoryStore (not suitable for production)');

    sessionMiddleware = session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 1000 * 60 * 60
      }
    });
  }

  app.use(sessionMiddleware);
  // Share Express session with Socket.IO handshake for context verification
  io.engine.use(sessionMiddleware);
  app.use(extractZoomContext);
}

function mountRoutes() {
  // API Routes
  app.use('/api/consent', consentRoutes);
  app.use('/api/participants', participantRoutes);
  app.use('/api/rtms', rtmsRoutes);
  app.use('/api/zoomapp', zoomappRoutes);
  app.use('/api/webhooks', webhookRoutes);

  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  });

  // Serve frontend static files or proxy once (never instantiate proxy per request)
  if (process.env.NODE_ENV === 'production') {
    const frontendBuildPath = path.join(__dirname, '../../frontend/build');
    app.use(express.static(frontendBuildPath));

    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        return next();
      }
      res.sendFile(path.join(frontendBuildPath, 'index.html'));
    });
  } else {
    const { createProxyMiddleware } = require('http-proxy-middleware');
    const frontendProxy = createProxyMiddleware({
      target: process.env.FRONTEND_URL || 'http://frontend:3000',
      changeOrigin: true,
      ws: true,
      logLevel: 'warn'
    });

    app.use('/', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/health')) {
        return next();
      }
      return frontendProxy(req, res, next);
    });
  }

  // Error handling middleware
  app.use((err, req, res, _next) => {
    console.error('Error:', err);
    res.status(err.status || 500).json({
      error: process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message,
      ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
    });
  });
}

// Start server
async function startServer() {
  try {
    // Initialize session middleware BEFORE mounting API and frontend routes
    await setupSession();
    mountRoutes();

    const PORT = config.port;
    server.listen(PORT, () => {
      console.log(`\n${'='.repeat(50)}`);
      console.log(`Zoom Consent RTMS Backend Server`);
      console.log(`${'='.repeat(50)}`);
      console.log(`Server running on port ${PORT}`);
      console.log(`Environment: ${config.nodeEnv}`);
      console.log(`Public URL: ${config.publicUrl}`);
      console.log(`WebSocket server initialized`);
      console.log(`${'='.repeat(50)}\n`);
    });

    let shutdownPromise;
    const shutdown = (signal) => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        console.log(`${signal} received, shutting down gracefully...`);
        const timeout = setTimeout(() => process.exit(1), 10000);
        timeout.unref();
        try {
          await new Promise((resolve) => io.close(resolve));
          if (server.listening) {
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
          }
          process.exitCode = 0;
        } catch (error) {
          console.error('Shutdown failed:', error);
          process.exitCode = 1;
        } finally {
          clearTimeout(timeout);
        }
      })();
      return shutdownPromise;
    };

    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { app, server, io, setupSession, mountRoutes, startServer };
