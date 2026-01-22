const express = require('express');
const router = express.Router();
const path = require('path');

/**
 * GET /api/zoomapp/home
 * App home page (Zoom client entry point)
 * In development: Returns HTML that redirects to root (handled by proxy middleware)
 * In production: Serves the built React app
 */
router.get('/home', (req, res) => {
  console.log('\n' + '='.repeat(60));
  console.log('📱 ZOOM APP HOME ACCESSED');
  console.log('='.repeat(60));
  console.log('User-Agent:', req.headers['user-agent']);
  console.log('X-Zoom-App-Context:', req.headers['x-zoom-app-context'] ? 'Present' : 'Not present');
  console.log('='.repeat(60) + '\n');

  // In development, redirect to root which will be proxied to frontend
  if (process.env.NODE_ENV === 'development') {
    console.log(`🔀 Redirecting to / (will be proxied to frontend)`);
    // Use JavaScript redirect instead of HTTP redirect to avoid CORS issues
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Loading Zoom App...</title>
          <script>
            // Redirect to root path which will be handled by the proxy middleware
            window.location.replace('/');
          </script>
          <noscript>
            <meta http-equiv="refresh" content="0; url=/" />
          </noscript>
        </head>
        <body>
          <p>Loading Zoom App...</p>
        </body>
      </html>
    `);
  }

  // In production, serve the built React app
  const frontendBuildPath = path.join(__dirname, '../../../frontend/build');
  res.sendFile(path.join(frontendBuildPath, 'index.html'));
});

/**
 * GET /api/zoomapp/install
 * Initiate web-based OAuth flow
 * Will be implemented in Phase 6
 */
router.get('/install', (req, res) => {
  res.send('OAuth Installation - Will be implemented in Phase 6');
});

/**
 * GET /api/zoomapp/auth
 * OAuth callback handler
 * Will be implemented in Phase 6
 */
router.get('/auth', (req, res) => {
  res.send('OAuth Callback - Will be implemented in Phase 6');
});

/**
 * GET /api/zoomapp/authorize
 * Get PKCE challenge for in-client OAuth
 * Will be implemented in Phase 6
 */
router.get('/authorize', (req, res) => {
  res.send('PKCE Challenge - Will be implemented in Phase 6');
});

/**
 * POST /api/zoomapp/onauthorized
 * Exchange OAuth code for token
 * Will be implemented in Phase 6
 */
router.post('/onauthorized', (req, res) => {
  res.send('OAuth Token Exchange - Will be implemented in Phase 6');
});

module.exports = router;
