const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db/db');
const router = express.Router();

// Helper function to validate user input
function validateUserInput(name, email, phone, password) {
  const errors = [];

  if (!name || name.trim().length < 2) {
    errors.push('Name must be at least 2 characters');
  }

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    errors.push('Invalid email format');
  }

  if (!phone || !/^\d{9,15}$/.test(phone)) {
    errors.push('Phone number must be 9-15 digits');
  }

  if (!password || password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }

  return errors;
}

// Helper function to log activity
async function logActivity(userId, userRole, action) {
  try {
    await db.query(
      `INSERT INTO activity_logs (actor_id, actor_role, action, created_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      [userId, userRole, action]
    );
  } catch (error) {
    console.error('Activity log error:', error);
  }
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
    phone = phone?.trim().replace(/\D/g, '');

    // Validate input
    const errors = validateUserInput(name, email, phone, password);
    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0] });
    }

    // Hash password
    const hash = await bcrypt.hash(password, 10);

    // Insert user
    const result = await db.query(
      `INSERT INTO users (name, email, phone, password, role, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'user', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id`,
      [name, email, phone, hash]
    );

    const userId = result.rows[0].id;

    // Log registration activity
    await logActivity(userId, 'user', 'register');

    res.status(201).json({ 
      success: true,
      message: 'Registration successful'
    });
  } catch (error) {
    console.error('Registration error:', error);
    
    // Handle unique constraint violations
    if (error.code === '23505') {
      if (error.constraint === 'users_email_key') {
        return res.status(400).json({ error: 'Email already registered' });
      }
      if (error.constraint === 'users_phone_key') {
        return res.status(400).json({ error: 'Phone number already registered' });
      }
    }
    
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
    const result = await db.query(
      `SELECT * FROM users WHERE (email = $1 OR phone = $1) AND active = true`,
      [identifier]
    );

    const user = result.rows[0];

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
    req.session.regenerate(async (regenerateErr) => {
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

      // Save session
      req.session.save(async (saveErr) => {
        if (saveErr) {
          console.error('Session save error:', saveErr);
          return res.status(500).json({ error: 'Login failed' });
        }

        // Update last login time
        await db.query(
          `UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [user.id]
        );

        // Log login activity
        await logActivity(user.id, user.role, 'login');

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
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /auth/logout
 * Logout and destroy session
 */
router.post('/logout', async (req, res) => {
  const userId = req.session?.user?.id;
  const userRole = req.session?.user?.role;

  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }

    // Clear session cookie
    res.clearCookie('meetandgo.sid');

    // Log logout activity (fire and forget)
    if (userId && userRole) {
      logActivity(userId, userRole, 'logout').catch(console.error);
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
    req.session.touch();
    res.json({ 
      success: true,
      message: 'Session refreshed'
    });
  } else {
    res.status(401).json({ error: 'No active session' });
  }
});

module.exports = router;