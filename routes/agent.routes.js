const express = require('express');
const db = require('../db/db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Valid status transitions (FSM)
const VALID_TRANSITIONS = {
  assigned: ['in_progress'],
  in_progress: ['completed']
};

// All allowed statuses for agents
const ALLOWED_STATUSES = ['assigned', 'in_progress', 'completed'];

// Helper function to log activity
function logActivity(agentId, action, requestId, fromStatus, toStatus, note, callback) {
  db.run(
    `INSERT INTO activity_logs (actor_id, actor_role, action, request_id, from_status, to_status, note, created_at)
     VALUES (?, 'agent', ?, ?, ?, ?, ?, datetime('now'))`,
    [agentId, action, requestId, fromStatus, toStatus, note],
    callback || (() => {})
  );
}

/**
 * GET /agent/requests
 * Get all requests assigned to the agent
 */
router.get('/requests', requireRole('agent'), (req, res) => {
  const agentId = req.session.user.id;
  
  // Parse query parameters
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;
  const status = req.query.status;

  // Build query
  let query = `
    SELECT
      r.id,
      r.user_id,
      r.destination,
      r.message,
      r.status,
      r.created_at,
      r.updated_at,
      u.name AS user_name,
      u.email AS user_email,
      u.phone AS user_phone
    FROM requests r
    INNER JOIN users u ON r.user_id = u.id
    WHERE r.agent_id = ?
  `;
  
  let params = [agentId];

  // Filter by status if provided
  if (status && ALLOWED_STATUSES.includes(status)) {
    query += ' AND r.status = ?';
    params.push(status);
  }

  query += ' ORDER BY r.created_at ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  // Get total count
  let countQuery = 'SELECT COUNT(*) as total FROM requests WHERE agent_id = ?';
  let countParams = [agentId];
  
  if (status && ALLOWED_STATUSES.includes(status)) {
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
 * GET /agent/requests/stats
 * Get request statistics for the agent
 */
router.get('/requests/stats', requireRole('agent'), (req, res) => {
  const agentId = req.session.user.id;

  db.get(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END) as assigned,
       SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
     FROM requests
     WHERE agent_id = ?`,
    [agentId],
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
 * GET /agent/requests/:id
 * Get details of a specific assigned request
 */
router.get('/requests/:id', requireRole('agent'), (req, res) => {
  const agentId = req.session.user.id;
  const requestId = Number(req.params.id);

  if (!Number.isInteger(requestId)) {
    return res.status(400).json({ error: 'Invalid request ID' });
  }

  db.get(
    `SELECT
      r.id,
      r.user_id,
      r.destination,
      r.message,
      r.status,
      r.created_at,
      r.updated_at,
      u.name AS user_name,
      u.email AS user_email,
      u.phone AS user_phone
    FROM requests r
    INNER JOIN users u ON r.user_id = u.id
    WHERE r.id = ? AND r.agent_id = ?`,
    [requestId, agentId],
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
 * POST /agent/requests/:id/status
 * Update the status of an assigned request
 */
router.post('/requests/:id/status', requireRole('agent'), (req, res) => {
  const agentId = req.session.user.id;
  const requestId = Number(req.params.id);
  let { status, note } = req.body;

  // Validate input
  if (!Number.isInteger(requestId)) {
    return res.status(400).json({ error: 'Invalid request ID' });
  }

  if (!status || typeof status !== 'string') {
    return res.status(400).json({ error: 'Status is required' });
  }

  // Normalize status to lowercase
  status = status.toLowerCase();

  // Validate status value
  if (!ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({ 
      error: `Invalid status. Allowed: ${ALLOWED_STATUSES.join(', ')}` 
    });
  }

  // Sanitize note if provided
  if (note) {
    note = String(note).trim();
    if (note.length > 500) {
      return res.status(400).json({ error: 'Note too long (max 500 characters)' });
    }
  }

  // Get current request
  db.get(
    `SELECT status FROM requests WHERE id = ? AND agent_id = ?`,
    [requestId, agentId],
    (err, request) => {
      if (err) {
        console.error('Failed to fetch request:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (!request) {
        return res.status(404).json({ error: 'Request not found or not assigned to you' });
      }

      const currentStatus = request.status;

      // Check if transition is valid
      const allowedNext = VALID_TRANSITIONS[currentStatus] || [];

      if (!allowedNext.includes(status)) {
        return res.status(400).json({
          error: `Invalid transition from '${currentStatus}' to '${status}'. Allowed: ${allowedNext.join(', ') || 'none'}`
        });
      }

      // Update status
      db.run(
        `UPDATE requests
         SET status = ?, updated_at = datetime('now')
         WHERE id = ? AND agent_id = ?`,
        [status, requestId, agentId],
        function (updateErr) {
          if (updateErr) {
            console.error('Failed to update status:', updateErr);
            return res.status(500).json({ error: 'Failed to update status' });
          }

          if (this.changes === 0) {
            return res.status(404).json({ error: 'Request not found' });
          }

          // Log activity
          logActivity(
            agentId,
            'update_status',
            requestId,
            currentStatus,
            status,
            note || `Updated from ${currentStatus} to ${status}`,
            (logErr) => {
              if (logErr) {
                console.error('Failed to log activity:', logErr);
              }
            }
          );

          res.json({ 
            success: true,
            message: 'Status updated successfully',
            previousStatus: currentStatus,
            newStatus: status
          });
        }
      );
    }
  );
});

/**
 * GET /agent/requests/:id/activity
 * Get activity log for a specific request
 */
router.get('/requests/:id/activity', requireRole('agent'), (req, res) => {
  const agentId = req.session.user.id;
  const requestId = Number(req.params.id);

  if (!Number.isInteger(requestId)) {
    return res.status(400).json({ error: 'Invalid request ID' });
  }

  // First verify the request belongs to this agent
  db.get(
    'SELECT id FROM requests WHERE id = ? AND agent_id = ?',
    [requestId, agentId],
    (err, request) => {
      if (err) {
        console.error('Failed to verify request:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (!request) {
        return res.status(404).json({ error: 'Request not found' });
      }

      // Get activity logs
      db.all(
        `SELECT
          al.id,
          al.actor_role,
          al.action,
          al.from_status,
          al.to_status,
          al.note,
          al.created_at,
          u.name AS actor_name
         FROM activity_logs al
         LEFT JOIN users u ON al.actor_id = u.id
         WHERE al.request_id = ?
         ORDER BY al.created_at DESC`,
        [requestId],
        (logErr, logs) => {
          if (logErr) {
            console.error('Failed to fetch activity logs:', logErr);
            return res.status(500).json({ error: 'Failed to fetch activity' });
          }

          res.json({ activities: logs });
        }
      );
    }
  );
});

module.exports = router;
