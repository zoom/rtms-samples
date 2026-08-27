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
const { securityHeaders } = require('./middleware/security');

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
webhookRoutes.setWebSocketServer(wsServer);

// Middleware
app.use(cors({
  origin: process.env.PUBLIC_URL || 'http://localhost:3001',
  credentials: true
}));
app.use(express.json({
  verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); }
}));
app.use(express.urlencoded({ extended: true }));
app.use(securityHeaders);

// Session configuration
async function setupSession() {
  try {
    const redisClient = await getRedisClient();

    app.use(session({
      store: new RedisStore({ client: redisClient }),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 1000 * 60 * 60 // 1 hour
      }
    }));

    console.log('Session middleware configured with Redis store');
  } catch (error) {
    console.error('Failed to setup Redis session store:', error);
    console.log('Falling back to MemoryStore (not suitable for production)');

    app.use(session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 1000 * 60 * 60
      }
    }));
  }
}

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

// Serve frontend static files
// In development: Frontend runs on separate port (handled by proxy in docker-compose)
// In production: Serve built files
if (process.env.NODE_ENV === 'production') {
  const frontendBuildPath = path.join(__dirname, '../../frontend/build');
  app.use(express.static(frontendBuildPath));

  // Catch-all route for React Router (only in production)
  app.get('*', (req, res, next) => {
    // Skip API routes
    if (req.path.startsWith('/api')) {
      return next();
    }
    res.sendFile(path.join(frontendBuildPath, 'index.html'));
  });
} else {
  // In development, proxy to frontend dev server for non-API routes
  const { createProxyMiddleware } = require('http-proxy-middleware');

  app.use(
    '/',
    (req, res, next) => {
      // Only proxy non-API routes
      if (req.path.startsWith('/api') || req.path.startsWith('/health')) {
        return next();
      }

      // Proxy to frontend dev server
      createProxyMiddleware({
        target: process.env.FRONTEND_URL || 'http://frontend:3000',
        changeOrigin: true,
        ws: true,
        logLevel: 'debug'
      })(req, res, next);
    }
  );
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// Start server
async function startServer() {
  try {
    await setupSession();

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

    // Handle shutdown gracefully
    process.on('SIGTERM', () => {
      console.log('SIGTERM received, shutting down gracefully...');
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

module.exports = { app, server, io };
