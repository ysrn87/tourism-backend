const express = require('express');
const db = require('../db/db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

// Helper function to sanitize strings
function sanitizeString(input) {
  return String(input).trim();
}

// Helper function to log activity
function logActivity(userId, action, requestId, note = null, callback) {
  db.run(
    `INSERT INTO activity_logs (actor_id, actor_role, action, request_id, note, created_at)
     VALUES (?, 'user', ?, ?, ?, datetime('now'))`,
    [userId, action, requestId, note],
    callback || (() => {})
  );
}

/**
 * POST /user/requests
 * Create a new travel request
 */
router.post('/requests', requireLogin, (req, res) => {
  const userId = req.session.user.id;
  let { destination, message } = req.body;

  // Sanitize and validate input
  if (!destination || typeof destination !== 'string') {
    return res.status(400).json({ error: 'Destination is required' });
  }

  destination = sanitizeString(destination);

  if (destination.length === 0) {
    return res.status(400).json({ error: 'Destination cannot be empty' });
  }

  if (destination.length > 200) {
    return res.status(400).json({ error: 'Destination too long (max 200 characters)' });
  }

  if (message) {
    message = sanitizeString(message);
    if (message.length > 1000) {
      return res.status(400).json({ error: 'Message too long (max 1000 characters)' });
    }
  }

  // Insert request
  db.run(
    `INSERT INTO requests (user_id, destination, message, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
    [userId, destination, message || null],
    function (err) {
      if (err) {
        console.error('Failed to create request:', err);
        return res.status(500).json({ error: 'Failed to create request' });
      }

      const requestId = this.lastID;

      // Log activity
      logActivity(userId, 'create_request', requestId, `Created request for ${destination}`);

      res.status(201).json({
        success: true,
        requestId: requestId,
        message: 'Request created successfully'
      });
    }
  );
});

/**
 * GET /user/requests
 * Get all requests for the logged-in user
 */
router.get('/requests', requireLogin, (req, res) => {
  const userId = req.session.user.id;
  
  // Parse query parameters
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;
  const status = req.query.status;

  // Build query
  let query = `
    SELECT
      r.id,
      r.destination,
      r.message,
      r.status,
      r.agent_id,
      r.created_at,
      r.updated_at,
      u.name AS agent_name
    FROM requests r
    LEFT JOIN users u ON r.agent_id = u.id
    WHERE r.user_id = ?
  `;
  
  let params = [userId];

  // Filter by status if provided
  if (status && ['pending', 'assigned', 'in_progress', 'completed', 'cancelled'].includes(status)) {
    query += ' AND r.status = ?';
    params.push(status);
  }

  query += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  // Get total count
  let countQuery = 'SELECT COUNT(*) as total FROM requests WHERE user_id = ?';
  let countParams = [userId];
  
  if (status && ['pending', 'assigned', 'in_progress', 'completed', 'cancelled'].includes(status)) {
    countQuery += ' AND status = ?';
    countParams.push(status);
  }

  db.get(countQuery, countParams, (countErr, countResult) => {
    if (countErr) {
      console.error('Failed to count requests:', countErr);
      return res.status(500).json({ error: 'Failed to fetch requests' });
    }

    // Get paginated requests
    db.all(query, params, (err, rows) => {
      if (err) {
        console.error('Failed to fetch requests:', err);
        return res.status(500).json({ error: 'Failed to fetch requests' });
      }

      res.json({
        requests: rows,
        pagination: {
          page,
          limit,
          total: countResult.total,
          totalPages: Math.ceil(countResult.total / limit)
        }
      });
    });
  });
});

/**
 * GET /user/requests/stats
 * Get request statistics for the logged-in user
 */
router.get('/requests/stats', requireLogin, (req, res) => {
  const userId = req.session.user.id;

  db.get(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
       SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END) as assigned,
       SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
     FROM requests
     WHERE user_id = ?`,
    [userId],
    (err, stats) => {
      if (err) {
        console.error('Failed to fetch stats:', err);
        return res.status(500).json({ error: 'Failed to fetch statistics' });
      }
      res.json(stats);
    }
  );
});

/**
 * GET /user/requests/:id
 * Get details of a specific request
 */
router.get('/requests/:id', requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const requestId = parseInt(req.params.id, 10);

  if (Number.isNaN(requestId)) {
    return res.status(400).json({ error: 'Invalid request ID' });
  }

  db.get(
    `SELECT
      r.id,
      r.destination,
      r.message,
      r.status,
      r.agent_id,
      r.created_at,
      r.updated_at,
      u.name AS agent_name,
      u.email AS agent_email,
      u.phone AS agent_phone
    FROM requests r
    LEFT JOIN users u ON r.agent_id = u.id
    WHERE r.id = ? AND r.user_id = ?`,
    [requestId, userId],
    (err, request) => {
      if (err) {
        console.error('Failed to fetch request:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (!request) {
        return res.status(404).json({ error: 'Request not found' });
      }

      res.json(request);
    }
  );
});

/**
 * PATCH /user/requests/:id/cancel
 * Cancel a pending or assigned request
 */
router.patch('/requests/:id/cancel', requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const requestId = parseInt(req.params.id, 10);

  if (Number.isNaN(requestId)) {
    return res.status(400).json({ error: 'Invalid request ID' });
  }

  // First check if request exists and belongs to user
  db.get(
    'SELECT id, status FROM requests WHERE id = ? AND user_id = ?',
    [requestId, userId],
    (err, request) => {
      if (err) {
        console.error('Failed to fetch request:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (!request) {
        return res.status(404).json({ error: 'Request not found' });
      }

      // Only allow canceling pending or assigned requests
      if (!['pending', 'assigned'].includes(request.status)) {
        return res.status(400).json({ 
          error: `Cannot cancel ${request.status} request` 
        });
      }

      // Update status to cancelled
      db.run(
        `UPDATE requests 
         SET status = 'cancelled', updated_at = datetime('now')
         WHERE id = ?`,
        [requestId],
        function (updateErr) {
          if (updateErr) {
            console.error('Failed to cancel request:', updateErr);
            return res.status(500).json({ error: 'Failed to cancel request' });
          }

          // Log activity
          logActivity(
            userId, 
            'cancel_request', 
            requestId, 
            `Cancelled request from ${request.status}`
          );

          res.json({ 
            success: true,
            message: 'Request cancelled successfully'
          });
        }
      );
    }
  );
});

module.exports = router;
