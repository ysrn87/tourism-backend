const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db/db');
const router = express.Router();

// Helper function to sanitize and validate input
function validateRegistration(name, email, phone, password) {
  const errors = [];

  // Name validation
  if (!name || name.trim().length < 2) {
    errors.push('Name must be at least 2 characters');
  }

  // Email validation
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    errors.push('Invalid email format');
  }

  // Phone validation
  if (!phone || !/^\d{9,15}$/.test(phone)) {
    errors.push('Phone number must be 9-15 digits');
  }

  // Password validation
  if (!password || password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }

  return errors;
}

// Helper function to log activity
function logActivity(userId, userRole, action, callback) {
  db.run(
    `INSERT INTO activity_logs (actor_id, actor_role, action, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [userId, userRole, action],
    callback
  );
}

/**
 * POST /auth/register
 * Register a new user
 */
router.post('/register', async (req, res) => {
  try {
    let { name, email, phone, password } = req.body;

    // Sanitize input
    name = name?.trim();
    email = email?.trim().toLowerCase();
    phone = phone?.trim().replace(/\D/g, ''); // Remove non-digits

    // Validate input
    const errors = validateRegistration(name, email, phone, password);
    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0] });
    }

    // Hash password
    const hash = await bcrypt.hash(password, 10);

    // Insert user
    db.run(
      `INSERT INTO users (name, email, phone, password, role, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user', 1, datetime('now'), datetime('now'))`,
      [name, email, phone, hash],
      function (err) {
        if (err) {
          console.error('Registration error:', err);
          
          // Specific error messages
          if (err.message.includes('UNIQUE constraint failed: users.email')) {
            return res.status(400).json({ error: 'Email already registered' });
          }
          if (err.message.includes('UNIQUE constraint failed: users.phone')) {
            return res.status(400).json({ error: 'Phone number already registered' });
          }
          
          return res.status(500).json({ error: 'Registration failed' });
        }

        const userId = this.lastID;

        // Log registration activity
        logActivity(userId, 'user', 'register', (logErr) => {
          if (logErr) console.error('Activity log error:', logErr);
        });

        res.status(201).json({ 
          success: true,
          message: 'Registration successful'
        });
      }
    );
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * POST /auth/login
 * Login with email or phone
 */
router.post('/login', async (req, res) => {
  try {
    let { identifier, password } = req.body;

    // Validate input
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    // Sanitize identifier
    identifier = identifier.trim().toLowerCase();

    // Find user
    db.get(
      `SELECT * FROM users WHERE (email = ? OR phone = ?) AND active = 1`,
      [identifier, identifier],
      async (err, user) => {
        if (err) {
          console.error('Login database error:', err);
          return res.status(500).json({ error: 'Login failed' });
        }

        // Generic error message (don't reveal if user exists)
        if (!user) {
          console.warn(`[AUTH] Failed login attempt for: ${identifier} from IP: ${req.ip}`);
          return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Verify password
        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
          console.warn(`[AUTH] Wrong password for user: ${user.id} from IP: ${req.ip}`);
          return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Regenerate session to prevent fixation
        req.session.regenerate((regenerateErr) => {
          if (regenerateErr) {
            console.error('Session regeneration error:', regenerateErr);
            return res.status(500).json({ error: 'Login failed' });
          }

          // Store user in session
          req.session.user = {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role
          };

          // CRITICAL: Save session before sending response
          req.session.save((saveErr) => {
            if (saveErr) {
              console.error('Session save error:', saveErr);
              return res.status(500).json({ error: 'Login failed' });
            }

            // Update last login time
            db.run(
              `UPDATE users SET updated_at = datetime('now') WHERE id = ?`,
              [user.id]
            );

            console.log(`[AUTH] Successful login: User ${user.id} (${user.role})`);

            res.json({ 
              success: true,
              user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role
              }
            });
          });
        });
      }
    );
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /auth/logout
 * Logout and destroy session
 */
router.post('/logout', (req, res) => {
  const userId = req.session?.user?.id;
  const userRole = req.session?.user?.role;

  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }

    // Clear session cookie
    res.clearCookie('meetandgo.sid');

    // Log logout activity (if user was logged in)
    if (userId && userRole) {
      logActivity(userId, userRole, 'logout', (logErr) => {
        if (logErr) console.error('Activity log error:', logErr);
      });
    }

    res.json({ 
      success: true,
      message: 'Logged out successfully'
    });
  });
});

/**
 * GET /auth/me
 * Get current user info
 */
router.get('/me', (req, res) => {
  if (req.session?.user) {
    res.json({ 
      user: {
        id: req.session.user.id,
        name: req.session.user.name,
        email: req.session.user.email,
        role: req.session.user.role
      }
    });
  } else {
    res.json({ user: null });
  }
});

/**
 * POST /auth/refresh
 * Refresh session to extend expiry
 */
router.post('/refresh', (req, res) => {
  if (req.session?.user) {
    req.session.touch(); // Extend session expiry
    res.json({ 
      success: true,
      message: 'Session refreshed'
    });
  } else {
    res.status(401).json({ error: 'No active session' });
  }
});

module.exports = router;
