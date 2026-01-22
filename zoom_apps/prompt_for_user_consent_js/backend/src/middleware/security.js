/**
 * Security middleware for OWASP headers and other security measures
 */

function securityHeaders(req, res, next) {
  // OWASP Security Headers (required by Zoom Apps)
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Content Security Policy
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://appssdk.zoom.us; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "connect-src 'self' https://*.zoom.us wss://*.zoom.us; " +
    "img-src 'self' data: https:; " +
    "frame-ancestors 'self' https://*.zoom.us;"
  );

  // Additional security headers
  res.setHeader('X-Frame-Options', 'ALLOW-FROM https://applications.zoom.us');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  next();
}

/**
 * Validate Zoom webhook signature
 */
function validateZoomWebhook(req, res, next) {
  // Webhook validation will be implemented in webhook routes
  next();
}

module.exports = {
  securityHeaders,
  validateZoomWebhook
};
