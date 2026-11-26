const express = require('express');
const router = express.Router();
const path = require('path');
const { decryptZoomAppContext, mintContextToken } = require('../middleware/security');

/**
 * GET /api/zoomapp/home
 * App home page (Zoom client entry point)
 * Verifies x-zoom-app-context if present and saves it in the server session.
 */
router.get('/home', (req, res) => {
  const contextHeader = req.headers['x-zoom-app-context'];
  const zoomContext = decryptZoomAppContext(contextHeader);

  if (zoomContext && req.session) {
    req.session.zoomContext = zoomContext;
    req.session.zoomAuthToken = mintContextToken(zoomContext);
  }

  // In development, redirect to root which will be proxied to frontend
  if (process.env.NODE_ENV === 'development') {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Loading Zoom App...</title>
          <script>
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
 * GET /api/zoomapp/session-token
 * Returns the short-lived HMAC token minted from the verified session context.
 */
router.get('/session-token', (req, res) => {
  if (!req.session?.zoomContext) {
    return res.status(401).json({ error: 'No verified Zoom App session context' });
  }

  const token = req.session.zoomAuthToken || mintContextToken(req.session.zoomContext);
  req.session.zoomAuthToken = token;

  return res.json({
    token,
    role: req.session.zoomContext.role || 'attendee',
    mid: req.session.zoomContext.mid || null
  });
});

router.get('/install', (req, res) => {
  res.send('OAuth Installation - Configure OAuth in Zoom Marketplace');
});

router.get('/auth', (req, res) => {
  res.send('OAuth Callback - Configure OAuth in Zoom Marketplace');
});

router.get('/authorize', (req, res) => {
  res.send('PKCE Challenge - Configure OAuth in Zoom Marketplace');
});

router.post('/onauthorized', (req, res) => {
  res.send('OAuth Token Exchange - Configure OAuth in Zoom Marketplace');
});

module.exports = router;
