const express = require('express');
const db = require('../db/db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Valid status transitions (FSM)
const VALID_TRANSITIONS = {
  assigned: ['in_progress'],
  in_progress: ['completed']
};

// All allowed statuses for tour guides
const ALLOWED_STATUSES = ['assigned', 'in_progress', 'completed'];

// Helper function to log activity
async function logActivity(tourGuideId, action, requestId, fromStatus, toStatus, note) {
  try {
    await db.query(
      `INSERT INTO activity_logs (actor_id, actor_role, action, request_id, from_status, to_status, note, created_at)
       VALUES ($1, 'tour_guide', $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
      [tourGuideId, action, requestId, fromStatus, toStatus, note]
    );
  } catch (error) {
    console.error('Activity log error:', error);
  }
}

/**
 * GET /tour-guide/requests
 * Get all requests assigned to the tour guide
 */
router.get('/requests', requireRole('tour_guide'), async (req, res) => {
  const tourGuideId = req.session.user.id;
  
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;
    const status = req.query.status;

    // Get all requests for counts
    const allResult = await db.query(
      'SELECT * FROM requests WHERE tour_guide_id = $1',
      [tourGuideId]
    );

    // Build query for filtered results
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
      WHERE r.tour_guide_id = $1
    `;
    
    let params = [tourGuideId];

    if (status && ALLOWED_STATUSES.includes(status)) {
      query += ' AND r.status = $2';
      params.push(status);
    }

    query += ' ORDER BY r.created_at ASC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
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
 * GET /tour-guide/requests/stats
 * Get request statistics for the tour guide
 */
router.get('/requests/stats', requireRole('tour_guide'), async (req, res) => {
  const tourGuideId = req.session.user.id;

  try {
    const result = await db.query(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE status = 'assigned') as assigned,
         COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
         COUNT(*) FILTER (WHERE status = 'completed') as completed
       FROM requests
       WHERE tour_guide_id = $1`,
      [tourGuideId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Failed to fetch stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

/**
 * GET /tour-guide/requests/:id
 * Get details of a specific assigned request
 */
router.get('/requests/:id', requireRole('tour_guide'), async (req, res) => {
  const tourGuideId = req.session.user.id;
  const requestId = Number(req.params.id);

  if (!Number.isInteger(requestId)) {
    return res.status(400).json({ error: 'Invalid request ID' });
  }

  try {
    const result = await db.query(
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
      WHERE r.id = $1 AND r.tour_guide_id = $2`,
      [requestId, tourGuideId]
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
 * POST /tour-guide/requests/:id/status
 * Update the status of an assigned request
 */
router.post('/requests/:id/status', requireRole('tour_guide'), async (req, res) => {
  const tourGuideId = req.session.user.id;
  const requestId = Number(req.params.id);
  let { status, note } = req.body;

  if (!Number.isInteger(requestId)) {
    return res.status(400).json({ error: 'Invalid request ID' });
  }

  if (!status || typeof status !== 'string') {
    return res.status(400).json({ error: 'Status is required' });
  }

  status = status.toLowerCase();

  if (!ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({ 
      error: `Invalid status. Allowed: ${ALLOWED_STATUSES.join(', ')}` 
    });
  }

  if (note) {
    note = String(note).trim();
    if (note.length > 500) {
      return res.status(400).json({ error: 'Note too long (max 500 characters)' });
    }
  }

  try {
    const checkResult = await db.query(
      `SELECT status FROM requests WHERE id = $1 AND tour_guide_id = $2`,
      [requestId, tourGuideId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found or not assigned to you' });
    }

    const currentStatus = checkResult.rows[0].status;
    const allowedNext = VALID_TRANSITIONS[currentStatus] || [];

    if (!allowedNext.includes(status)) {
      return res.status(400).json({
        error: `Invalid transition from '${currentStatus}' to '${status}'. Allowed: ${allowedNext.join(', ') || 'none'}`
      });
    }

    const updateResult = await db.query(
      `UPDATE requests
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND tour_guide_id = $3`,
      [status, requestId, tourGuideId]
    );

    if (updateResult.rowCount === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    await logActivity(
      tourGuideId,
      'update_status',
      requestId,
      currentStatus,
      status,
      note || `Updated from ${currentStatus} to ${status}`
    );

    res.json({ 
      success: true,
      message: 'Status updated successfully',
      previousStatus: currentStatus,
      newStatus: status
    });
  } catch (error) {
    console.error('Failed to update status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

/**
 * GET /tour-guide/requests/:id/activity
 * Get activity log for a specific request
 */
router.get('/requests/:id/activity', requireRole('tour_guide'), async (req, res) => {
  const tourGuideId = req.session.user.id;
  const requestId = Number(req.params.id);

  if (!Number.isInteger(requestId)) {
    return res.status(400).json({ error: 'Invalid request ID' });
  }

  try {
    const checkResult = await db.query(
      'SELECT id FROM requests WHERE id = $1 AND tour_guide_id = $2',
      [requestId, tourGuideId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const result = await db.query(
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
       WHERE al.request_id = $1
       ORDER BY al.created_at DESC`,
      [requestId]
    );

    res.json({ activities: result.rows });
  } catch (error) {
    console.error('Failed to fetch activity logs:', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

module.exports = router;