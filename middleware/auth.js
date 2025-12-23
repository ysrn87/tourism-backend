// Track suspicious activity
const suspiciousAttempts = new Map();

function trackSuspiciousActivity(identifier, ip) {
  const key = `${identifier || 'anonymous'}-${ip}`;
  const attempts = suspiciousAttempts.get(key) || 0;
  suspiciousAttempts.set(key, attempts + 1);
  
  if (attempts > 10) {
    console.error(`[SECURITY ALERT] High number of unauthorized attempts from ${key}`);
  }
  
  // Auto-cleanup after 1 hour
  setTimeout(() => suspiciousAttempts.delete(key), 3600000);
}

/**
 * Middleware to require user authentication
 */
function requireLogin(req, res, next) {
  // Defensive checks for session and user
  if (
    !req.session ||
    !req.session.user ||
    typeof req.session.user.id !== 'number' ||
    typeof req.session.user.role !== 'string'
  ) {
    console.warn(
      `[SECURITY] Unauthorized access attempt from IP: ${req.ip} to ${req.originalUrl}`
    );
    
    trackSuspiciousActivity(null, req.ip);
    
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Attach user to request for easy access
  req.user = req.session.user;
  
  next();
}

/**
 * Middleware to require specific role(s)
 * @param {...string} roles - One or more allowed roles
 * @example requireRole('admin')
 * @example requireRole('admin', 'agent')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    // Ensure user is logged in
    if (
      !req.session ||
      !req.session.user ||
      typeof req.session.user.role !== 'string'
    ) {
      console.warn(
        `[SECURITY] Unauthorized role access attempt from IP: ${req.ip} to ${req.originalUrl}`
      );
      
      trackSuspiciousActivity(null, req.ip);
      
      return res.status(401).json({ error: 'Unauthorized' });
    }

//     // Check if user's role matches any allowed role
    if (!roles.includes(req.session.user.role)) {
      console.warn(
        `[SECURITY] Role mismatch: ${req.session.user.role} (User ID: ${req.session.user.id}) ` +
        `tried to access ${req.originalUrl} (required: ${roles.join(' or ')})`
      );
      
      trackSuspiciousActivity(req.session.user.id, req.ip);
      
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Attach user to request
    req.user = req.session.user;
    
    next();
  };
}

/**
 * Middleware to check if user owns the resource or is admin
 * @param {Function} getResourceUserId - Async function to get resource owner ID
 * @example requireOwnership(async (req) => {
 *   const request = await getRequestById(req.params.id);
 *   return request.user_id;
 * })
 */
function requireOwnership(getResourceUserId) {
  return async (req, res, next) => {
    try {
      if (!req.session?.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const resourceUserId = await getResourceUserId(req);
      
      // Allow if user owns resource or is admin
      if (
        req.session.user.id === resourceUserId || 
        req.session.user.role === 'admin'
      ) {
        req.user = req.session.user;
        return next();
      }

      console.warn(
        `[SECURITY] User ${req.session.user.id} tried to access resource owned by ${resourceUserId}`
      );
      
      return res.status(403).json({ error: 'Forbidden: Not your resource' });
      
    } catch (error) {
      console.error('[SECURITY] Error checking ownership:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

/**
 * Middleware to check session validity and expiry
 */
function checkSessionExpiry(req, res, next) {
  if (req.session?.user && req.session.cookie?.expires) {
    const now = new Date();
    const expires = new Date(req.session.cookie.expires);
    
    if (now > expires) {
      console.warn(
        `[SECURITY] Expired session from User ID: ${req.session.user.id}, IP: ${req.ip}`
      );
      
      req.session.destroy((err) => {
        if (err) {
          console.error('Session destruction error:', err);
        }
      });
      
      return res.status(401).json({ error: 'Session expired' });
    }
  }
  
  next();
}

/**
 * Optional: Middleware to refresh session activity
 * Extends session expiry on each request
 */
function refreshSession(req, res, next) {
  if (req.session?.user) {
    req.session.touch(); // Refresh session expiry
  }
  next();
}

module.exports = { 
  requireLogin, 
  requireRole,
  requireOwnership,
  checkSessionExpiry,
  refreshSession
};