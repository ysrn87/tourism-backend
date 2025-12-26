const express = require('express');
const db = require('../db/db');
const { requireRole } = require('../middleware/auth');
const bcrypt = require('bcrypt');

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
async function logActivity(adminId, action, requestId, note) {
  try {
    await db.query(
      `INSERT INTO activity_logs (actor_id, actor_role, action, request_id, note, created_at)
       VALUES ($1, 'admin', $2, $3, $4, CURRENT_TIMESTAMP)`,
      [adminId, action, requestId, note]
    );
  } catch (error) {
    console.error('Activity log error:', error);
  }
}

/**
 * POST /admin/register/tour-guide
 * Register a new tour guide
 */
router.post('/register/tour-guide', requireRole('admin'), async (req, res) => {
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

    // Insert tour guide
    const result = await db.query(
      `INSERT INTO users (name, email, phone, password, role, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'tour_guide', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id`,
      [name, email, phone, hash]
    );

    const tourGuideId = result.rows[0].id;

    // Log activity
    await logActivity(
      req.session.user.id,
      'registertour_guide',
      null,
      `Registered new tour guide: ${name} (ID: ${tourGuideId})`
    );

    res.status(201).json({
      success: true,
      tourGuideId: tourGuideId,
      message: 'Tour Guide registered successfully'
    });
  } catch (error) {
    console.error('Tour Guide registration error:', error);

    if (error.code === '23505') {
      if (error.constraint === 'users_email_key') {
        return res.status(400).json({ error: 'Email already registered' });
      }
      if (error.constraint === 'users_phone_key') {
        return res.status(400).json({ error: 'Phone number already registered' });
      }
    }

    res.status(500).json({ error: 'Failed to register tour guide' });
  }
});

/**
 * GET /admin/tour-guides
 * Get all tour guides with their workload
 */
router.get('/tour-guides', requireRole('admin'), async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  try {
    const result = await db.query(
      `SELECT
         u.id,
         u.name,
         u.email,
         u.phone,
         u.active,
         u.created_at,
         COUNT(r.id) as total_requests,
         COUNT(r.id) FILTER (WHERE r.status IN ('assigned', 'in_progress')) as active_requests,
         COUNT(r.id) FILTER (WHERE r.status = 'completed') as completed_requests
       FROM users u
       LEFT JOIN requests r ON u.id = r.tour_guide_id
       WHERE u.role = 'tour_guide'
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    // Get total count
    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM users WHERE role = 'tour_guide'`
    );

    res.json({
      tourGuides: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].total),
        totalPages: Math.ceil(countResult.rows[0].total / limit)
      }
    });
  } catch (error) {
    console.error('Failed to fetch tour guides:', error);
    res.status(500).json({ error: 'Failed to fetch tour guides' });
  }
});

/**
 * GET /admin/tour-guides/:id
 * Get tour guide details with their requests
 */
router.get('/tour-guides/:id', requireRole('admin'), async (req, res) => {
  const tourGuideId = Number(req.params.id);

  if (!Number.isInteger(tourGuideId)) {
    return res.status(400).json({ error: 'Invalid tour guide ID' });
  }

  try {
    const tourGuideResult = await db.query(
      `SELECT id, name, email, phone, active, created_at
       FROM users
       WHERE id = $1 AND role = 'tour_guide'`,
      [tourGuideId]
    );

    if (tourGuideResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tour Guide not found' });
    }

    // Get tour guide's requests
    const requestsResult = await db.query(
      `SELECT
         r.id,
         r.destination,
         r.status,
         r.created_at,
         r.updated_at,
         u.name AS user_name
       FROM requests r
       INNER JOIN users u ON r.user_id = u.id
       WHERE r.tour_guide_id = $1
       ORDER BY r.created_at DESC
       LIMIT 50`,
      [tourGuideId]
    );

    res.json({
      tourGuide: tourGuideResult.rows[0],
      requests: requestsResult.rows
    });
  } catch (error) {
    console.error('Failed to fetch tour guide details:', error);
    res.status(500).json({ error: 'Failed to fetch tour guide details' });
  }
});

/**
 * PATCH /admin/tour-guides/:id/toggle-active
 * Activate or deactivate an tour guide
 */
router.patch('/tour-guides/:id/toggle-active', requireRole('admin'), async (req, res) => {
  const tourGuideId = Number(req.params.id);

  if (!Number.isInteger(tourGuideId)) {
    return res.status(400).json({ error: 'Invalid tour guide ID' });
  }

  try {
    const checkResult = await db.query(
      'SELECT id, name, active FROM users WHERE id = $1 AND role = $2',
      [tourGuideId, 'tour_guide']
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tour Guide not found' });
    }

    const tourGuide = checkResult.rows[0];
    const newActiveStatus = !tourGuide.active;

    await db.query(
      'UPDATE users SET active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newActiveStatus, tourGuideId]
    );

    // Log activity
    await logActivity(
      req.session.user.id,
      'toggletour_guide_status',
      null,
      `${newActiveStatus ? 'Activated' : 'Deactivated'} tourGuide: ${tourGuide.name}`
    );

    res.json({
      success: true,
      message: `Tour Guide ${newActiveStatus ? 'activated' : 'deactivated'} successfully`,
      active: newActiveStatus
    });
  } catch (error) {
    console.error('Failed to update tour guide:', error);
    res.status(500).json({ error: 'Failed to update tour guide' });
  }
});

/**
 * GET /admin/requests
 * Get all requests (with optional filters)
 */
router.get('/requests', requireRole('admin'), async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const status = req.query.status;
  const destination = req.query.destination;

  try {
    // Get all requests for counts
    const allResult = await db.query('SELECT * FROM requests');

    // Build filtered query
    let query = `
      SELECT
        r.id,
        r.destination,
        r.message,
        r.status,
        r.tour_guide_id,
        r.created_at,
        r.updated_at,
        u.id AS user_id,
        u.name AS user_name,
        u.email AS user_email,
        a.name AS tour_guide_name
      FROM requests r
      INNER JOIN users u ON r.user_id = u.id
      LEFT JOIN users a ON r.tour_guide_id = a.id
      WHERE 1=1
    `;

    let params = [];
    let paramCount = 0;

    // Filter by status
    if (status && ['pending', 'assigned', 'in_progress', 'completed', 'cancelled'].includes(status)) {
      paramCount++;
      query += ` AND r.status = $${paramCount}`;
      params.push(status);
    }

    // Filter by destination
    if (destination) {
      paramCount++;
      query += ` AND r.destination ILIKE $${paramCount}`;
      params.push(`%${destination}%`);
    }

    paramCount++;
    query += ` ORDER BY r.created_at ASC LIMIT $${paramCount}`;
    params.push(limit);

    paramCount++;
    query += ` OFFSET $${paramCount}`;
    params.push(offset);

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
 * GET /admin/requests/:id
 * Get detailed request information
 */
router.get('/requests/:id', requireRole('admin'), async (req, res) => {
  const requestId = Number(req.params.id);

  if (!Number.isInteger(requestId)) {
    return res.status(400).json({ error: 'Invalid request ID' });
  }

  try {
    const requestResult = await db.query(
      `SELECT
        r.*,
        u.name AS user_name,
        u.email AS user_email,
        u.phone AS user_phone,
        a.name AS tour_guide_name,
        a.email AS tour_guide_email,
        a.phone AS tour_guide_phone
      FROM requests r
      INNER JOIN users u ON r.user_id = u.id
      LEFT JOIN users a ON r.tour_guide_id = a.id
      WHERE r.id = $1`,
      [requestId]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    // Get activity logs
    const activityResult = await db.query(
      `SELECT
        al.*,
        u.name AS actor_name
       FROM activity_logs al
       LEFT JOIN users u ON al.actor_id = u.id
       WHERE al.request_id = $1
       ORDER BY al.created_at DESC`,
      [requestId]
    );

    res.json({
      request: requestResult.rows[0],
      activities: activityResult.rows
    });
  } catch (error) {
    console.error('Failed to fetch request:', error);
    res.status(500).json({ error: 'Failed to fetch request details' });
  }
});

/**
 * POST /admin/requests/:id/assign
 * Assign a request to an tour guide
 */
router.post('/requests/:id/assign', requireRole('admin'), async (req, res) => {
  const adminId = req.session.user.id;
  const requestId = Number(req.params.id);
  const { tourGuideId } = req.body;

  // Validate input
  if (!Number.isInteger(requestId)) {
    return res.status(400).json({ error: 'Invalid request ID' });
  }

  if (!tourGuideId || !Number.isInteger(Number(tourGuideId))) {
    return res.status(400).json({ error: 'Valid tour guide ID is required' });
  }

  try {
    // Validate tour guide exists and is active
    const tourGuideResult = await db.query(
      `SELECT id, name, active FROM users WHERE id = $1 AND role = 'tour_guide'`,
      [tourGuideId]
    );

    if (tourGuideResult.rows.length === 0) {
      return res.status(400).json({ error: 'Tour Guide not found' });
    }

    const tourGuide = tourGuideResult.rows[0];

    if (!tourGuide.active) {
      return res.status(400).json({ error: 'Tour Guide is not active' });
    }

    // Check tour guide workload
    const workloadResult = await db.query(
      `SELECT COUNT(*) as active_count
       FROM requests
       WHERE tour_guide_id = $1 AND status IN ('assigned', 'in_progress')`,
      [tourGuideId]
    );

    if (parseInt(workloadResult.rows[0].active_count) >= 10) {
      return res.status(400).json({
        error: 'Tour Guide has too many active requests. Please choose another tour guide.'
      });
    }

    // Assign request
    const updateResult = await db.query(
      `UPDATE requests
       SET status = 'assigned', tour_guide_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND status = 'pending'`,
      [tourGuideId, requestId]
    );

    if (updateResult.rowCount === 0) {
      // Check why assignment failed
      const checkResult = await db.query(
        'SELECT id, status FROM requests WHERE id = $1',
        [requestId]
      );

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'Request not found' });
      }

      return res.status(400).json({
        error: `Cannot assign request with status '${checkResult.rows[0].status}'`
      });
    }

    // Log activity
    await logActivity(
      adminId,
      'assign_request',
      requestId,
      `Assigned request to tour guide ${tourGuide.name} (ID: ${tourGuideId})`
    );

    res.json({
      success: true,
      message: `Request assigned to ${tourGuide.name} successfully`
    });
  } catch (error) {
    console.error('Failed to assign request:', error);
    res.status(500).json({ error: 'Failed to assign request' });
  }
});

/**
 * POST /admin/requests/:id/reassign
 * Reassign a request to a different tour guide
 */
router.post('/requests/:id/reassign', requireRole('admin'), async (req, res) => {
  const adminId = req.session.user.id;
  const requestId = Number(req.params.id);
  const { tourGuideId } = req.body;

  if (!Number.isInteger(requestId)) {
    return res.status(400).json({ error: 'Invalid request ID' });
  }

  if (!tourGuideId || !Number.isInteger(Number(tourGuideId))) {
    return res.status(400).json({ error: 'Valid tour guide ID is required' });
  }

  try {
    // Validate tour guide
    const tourGuideResult = await db.query(
      `SELECT id, name, active FROM users WHERE id = $1 AND role = 'tour_guide'`,
      [tourGuideId]
    );

    if (tourGuideResult.rows.length === 0) {
      return res.status(400).json({ error: 'Tour Guide not found' });
    }

    const tourGuide = tourGuideResult.rows[0];

    if (!tourGuide.active) {
      return res.status(400).json({ error: 'Tour Guide is not active' });
    }

    // Get current request info
    const requestResult = await db.query(
      `SELECT r.id, r.status, r.tour_guide_id, a.name as oldtour_guide_name
       FROM requests r
       LEFT JOIN users a ON r.tour_guide_id = a.id
       WHERE r.id = $1`,
      [requestId]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const request = requestResult.rows[0];

    if (!['assigned', 'in_progress'].includes(request.status)) {
      return res.status(400).json({
        error: `Cannot reassign ${request.status} request`
      });
    }

    // Reassign
    await db.query(
      `UPDATE requests
       SET tour_guide_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [tourGuideId, requestId]
    );

    // Log activity
    await logActivity(
      adminId,
      'reassign_request',
      requestId,
      `Reassigned from ${request.oldtour_guide_name || 'unassigned'} to ${tourGuide.name}`
    );

    res.json({
      success: true,
      message: `Request reassigned to ${tourGuide.name} successfully`
    });
  } catch (error) {
    console.error('Failed to reassign request:', error);
    res.status(500).json({ error: 'Failed to reassign request' });
  }
});

/**
 * GET /admin/dashboard/stats
 * Get dashboard statistics
 */
router.get('/dashboard/stats', requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM requests) as total_requests,
        (SELECT COUNT(*) FROM requests WHERE status = 'pending') as pending_requests,
        (SELECT COUNT(*) FROM requests WHERE status = 'assigned') as assigned_requests,
        (SELECT COUNT(*) FROM requests WHERE status = 'in_progress') as in_progress_requests,
        (SELECT COUNT(*) FROM requests WHERE status = 'completed') as completed_requests,
        (SELECT COUNT(*) FROM requests WHERE status = 'cancelled') as cancelled_requests,
        (SELECT COUNT(*) FROM users WHERE role = 'user') as total_users,
        (SELECT COUNT(*) FROM users WHERE role = 'tour_guide') as total_tour_guides,
        (SELECT COUNT(*) FROM users WHERE role = 'tour_guide' AND active = true) as active_tour_guides
    `);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Failed to fetch stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

module.exports = router;