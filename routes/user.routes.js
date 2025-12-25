const express = require('express');
const db = require('../db/db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

// Helper function to sanitize strings
function sanitizeString(input) {
  return String(input).trim();
}

// Helper function to log activity
async function logActivity(userId, action, requestId, note = null) {
  try {
    await db.query(
      `INSERT INTO activity_logs (actor_id, actor_role, action, request_id, note, created_at)
       VALUES ($1, 'user', $2, $3, $4, CURRENT_TIMESTAMP)`,
      [userId, action, requestId, note]
    );
  } catch (error) {
    console.error('Activity log error:', error);
  }
}

/**
 * POST /user/requests
 * Create a new travel request
 */
router.post('/requests', requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  let { destination, message } = req.body;

  try {
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
    const result = await db.query(
      `INSERT INTO requests (user_id, destination, message, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id`,
      [userId, destination, message || null]
    );

    const requestId = result.rows[0].id;

    // Log activity
    await logActivity(userId, 'create_request', requestId, `Created request for ${destination}`);

    res.status(201).json({
      success: true,
      requestId: requestId,
      message: 'Request created successfully'
    });
  } catch (error) {
    console.error('Failed to create request:', error);
    res.status(500).json({ error: 'Failed to create request' });
  }
});

/**
 * GET /user/requests
 * Get all requests for the logged-in user
 */
router.get('/requests', requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  
  try {
    // Parse query parameters
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;
    const status = req.query.status;

    // Get all requests for counts
    const allResult = await db.query(
      'SELECT * FROM requests WHERE user_id = $1',
      [userId]
    );

    // Build query for filtered results
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
      WHERE r.user_id = $1
    `;
    
    let params = [userId];

    // Filter by status if provided
    if (status && ['pending', 'assigned', 'in_progress', 'completed', 'cancelled'].includes(status)) {
      query += ' AND r.status = $2';
      params.push(status);
    }

    query += ' ORDER BY r.created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);

    const result = await db.query(query, params);

    res.json({
      requests: result.rows,
      pagination: {
        page,
        limit,
        total: allResult.rows.length,
        totalPages: Math.ceil(allResult.rows.length / limit)
      }
    });
  } catch (error) {
    console.error('Failed to fetch requests:', error);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

/**
 * GET /user/requests/stats
 * Get request statistics for the logged-in user
 */
router.get('/requests/stats', requireLogin, async (req, res) => {
  const userId = req.session.user.id;

  try {
    const result = await db.query(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE status = 'pending') as pending,
         COUNT(*) FILTER (WHERE status = 'assigned') as assigned,
         COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
         COUNT(*) FILTER (WHERE status = 'completed') as completed,
         COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled
       FROM requests
       WHERE user_id = $1`,
      [userId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Failed to fetch stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

/**
 * GET /user/requests/:id
 * Get details of a specific request
 */
router.get('/requests/:id', requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  const requestId = parseInt(req.params.id, 10);

  if (Number.isNaN(requestId)) {
    return res.status(400).json({ error: 'Invalid request ID' });
  }

  try {
    const result = await db.query(
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
      WHERE r.id = $1 AND r.user_id = $2`,
      [requestId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Failed to fetch request:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * PATCH /user/requests/:id/cancel
 * Cancel a pending or assigned request
 */
router.patch('/requests/:id/cancel', requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  const requestId = parseInt(req.params.id, 10);

  if (Number.isNaN(requestId)) {
    return res.status(400).json({ error: 'Invalid request ID' });
  }

  try {
    // First check if request exists and belongs to user
    const checkResult = await db.query(
      'SELECT id, status FROM requests WHERE id = $1 AND user_id = $2',
      [requestId, userId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const request = checkResult.rows[0];

    // Only allow canceling pending or assigned requests
    if (!['pending', 'assigned'].includes(request.status)) {
      return res.status(400).json({ 
        error: `Cannot cancel ${request.status} request` 
      });
    }

    // Update status to cancelled
    await db.query(
      `UPDATE requests 
       SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [requestId]
    );

    // Log activity
    await logActivity(
      userId, 
      'cancel_request', 
      requestId, 
      `Cancelled request from ${request.status}`
    );

    res.json({ 
      success: true,
      message: 'Request cancelled successfully'
    });
  } catch (error) {
    console.error('Failed to cancel request:', error);
    res.status(500).json({ error: 'Failed to cancel request' });
  }
});

module.exports = router;