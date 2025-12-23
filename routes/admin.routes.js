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
function logActivity(adminId, action, requestId, note, callback) {
  db.run(
    `INSERT INTO activity_logs (actor_id, actor_role, action, request_id, note, created_at)
     VALUES (?, 'admin', ?, ?, ?, datetime('now'))`,
    [adminId, action, requestId, note],
    callback || (() => {})
  );
}

/**
 * POST /admin/register/agent
 * Register a new agent
 */
router.post('/register/agent', requireRole('admin'), async (req, res) => {
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

    // Insert agent
    db.run(
      `INSERT INTO users (name, email, phone, password, role, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'agent', 1, datetime('now'), datetime('now'))`,
      [name, email, phone, hash],
      function (err) {
        if (err) {
          console.error('Failed to register agent:', err);

          if (err.message.includes('UNIQUE constraint failed: users.email')) {
            return res.status(400).json({ error: 'Email already registered' });
          }
          if (err.message.includes('UNIQUE constraint failed: users.phone')) {
            return res.status(400).json({ error: 'Phone number already registered' });
          }

          return res.status(500).json({ error: 'Failed to register agent' });
        }

        const agentId = this.lastID;

        // Log activity
        logActivity(
          req.session.user.id,
          'register_agent',
          null,
          `Registered new agent: ${name} (ID: ${agentId})`
        );

        res.status(201).json({
          success: true,
          agentId: agentId,
          message: 'Agent registered successfully'
        });
      }
    );
  } catch (error) {
    console.error('Agent registration error:', error);
    res.status(500).json({ error: 'Failed to register agent' });
  }
});

/**
 * GET /admin/agents
 * Get all agents with their workload
 */
router.get('/agents', requireRole('admin'), (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  db.all(
    `SELECT
       u.id,
       u.name,
       u.email,
       u.phone,
       u.active,
       u.created_at,
       COUNT(r.id) as total_requests,
       SUM(CASE WHEN r.status IN ('assigned', 'in_progress') THEN 1 ELSE 0 END) as active_requests,
       SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) as completed_requests
     FROM users u
     LEFT JOIN requests r ON u.id = r.agent_id
     WHERE u.role = 'agent'
     GROUP BY u.id
     ORDER BY u.created_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset],
    (err, agents) => {
      if (err) {
        console.error('Failed to fetch agents:', err);
        return res.status(500).json({ error: 'Failed to fetch agents' });
      }

      // Get total count
      db.get(
        `SELECT COUNT(*) as total FROM users WHERE role = 'agent'`,
        [],
        (countErr, countResult) => {
          if (countErr) {
            console.error('Failed to count agents:', countErr);
            return res.status(500).json({ error: 'Failed to fetch agents' });
          }

          res.json({
            agents,
            pagination: {
              page,
              limit,
              total: countResult.total,
              totalPages: Math.ceil(countResult.total / limit)
            }
          });
        }
      );
    }
  );
});

/**
 * GET /admin/agents/:id
 * Get agent details with their requests
 */
router.get('/agents/:id', requireRole('admin'), (req, res) => {
  const agentId = Number(req.params.id);

  if (!Number.isInteger(agentId)) {
    return res.status(400).json({ error: 'Invalid agent ID' });
  }

  db.get(
    `SELECT id, name, email, phone, active, created_at
     FROM users
     WHERE id = ? AND role = 'agent'`,
    [agentId],
    (err, agent) => {
      if (err) {
        console.error('Failed to fetch agent:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      // Get agent's requests
      db.all(
        `SELECT
           r.id,
           r.destination,
           r.status,
           r.created_at,
           r.updated_at,
           u.name AS user_name
         FROM requests r
         INNER JOIN users u ON r.user_id = u.id
         WHERE r.agent_id = ?
         ORDER BY r.created_at DESC
         LIMIT 50`,
        [agentId],
        (reqErr, requests) => {
          if (reqErr) {
            console.error('Failed to fetch agent requests:', reqErr);
            return res.status(500).json({ error: 'Failed to fetch agent details' });
          }

          res.json({
            agent,
            requests
          });
        }
      );
    }
  );
});

/**
 * PATCH /admin/agents/:id/toggle-active
 * Activate or deactivate an agent
 */
router.patch('/agents/:id/toggle-active', requireRole('admin'), (req, res) => {
  const agentId = Number(req.params.id);

  if (!Number.isInteger(agentId)) {
    return res.status(400).json({ error: 'Invalid agent ID' });
  }

  db.get(
    'SELECT id, name, active FROM users WHERE id = ? AND role = ?',
    [agentId, 'agent'],
    (err, agent) => {
      if (err) {
        console.error('Failed to fetch agent:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      const newActiveStatus = agent.active ? 0 : 1;

      db.run(
        'UPDATE users SET active = ?, updated_at = datetime(\'now\') WHERE id = ?',
        [newActiveStatus, agentId],
        function (updateErr) {
          if (updateErr) {
            console.error('Failed to update agent:', updateErr);
            return res.status(500).json({ error: 'Failed to update agent' });
          }

          // Log activity
          logActivity(
            req.session.user.id,
            'toggle_agent_status',
            null,
            `${newActiveStatus ? 'Activated' : 'Deactivated'} agent: ${agent.name}`
          );

          res.json({
            success: true,
            message: `Agent ${newActiveStatus ? 'activated' : 'deactivated'} successfully`,
            active: newActiveStatus
          });
        }
      );
    }
  );
});

/**
 * GET /admin/requests
 * Get all requests (with optional filters)
 */
router.get('/requests', requireRole('admin'), (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const status = req.query.status || 'pending';
  const destination = req.query.destination;

  let query = `
    SELECT
      r.id,
      r.destination,
      r.message,
      r.status,
      r.agent_id,
      r.created_at,
      r.updated_at,
      u.id AS user_id,
      u.name AS user_name,
      u.email AS user_email,
      a.name AS agent_name
    FROM requests r
    INNER JOIN users u ON r.user_id = u.id
    LEFT JOIN users a ON r.agent_id = a.id
    WHERE 1=1
  `;

  let params = [];

  // Filter by status
  if (status && ['pending', 'assigned', 'in_progress', 'completed', 'cancelled'].includes(status)) {
    query += ' AND r.status = ?';
    params.push(status);
  }

  // Filter by destination
  if (destination) {
    query += ' AND r.destination LIKE ?';
    params.push(`%${destination}%`);
  }

  query += ' ORDER BY r.created_at ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  // Get total count
  let countQuery = 'SELECT COUNT(*) as total FROM requests WHERE 1=1';
  let countParams = [];

  if (status && ['pending', 'assigned', 'in_progress', 'completed', 'cancelled'].includes(status)) {
    countQuery += ' AND status = ?';
    countParams.push(status);
  }

  if (destination) {
    countQuery += ' AND destination LIKE ?';
    countParams.push(`%${destination}%`);
  }

  db.get(countQuery, countParams, (countErr, countResult) => {
    if (countErr) {
      console.error('Failed to count requests:', countErr);
      return res.status(500).json({ error: 'Failed to fetch requests' });
    }

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
 * GET /admin/requests/:id
 * Get detailed request information
 */
router.get('/requests/:id', requireRole('admin'), (req, res) => {
  const requestId = Number(req.params.id);

  if (!Number.isInteger(requestId)) {
    return res.status(400).json({ error: 'Invalid request ID' });
  }

  db.get(
    `SELECT
      r.*,
      u.name AS user_name,
      u.email AS user_email,
      u.phone AS user_phone,
      a.name AS agent_name,
      a.email AS agent_email,
      a.phone AS agent_phone
    FROM requests r
    INNER JOIN users u ON r.user_id = u.id
    LEFT JOIN users a ON r.agent_id = a.id
    WHERE r.id = ?`,
    [requestId],
    (err, request) => {
      if (err) {
        console.error('Failed to fetch request:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (!request) {
        return res.status(404).json({ error: 'Request not found' });
      }

      // Get activity logs
      db.all(
        `SELECT
          al.*,
          u.name AS actor_name
         FROM activity_logs al
         LEFT JOIN users u ON al.actor_id = u.id
         WHERE al.request_id = ?
         ORDER BY al.created_at DESC`,
        [requestId],
        (logErr, activities) => {
          if (logErr) {
            console.error('Failed to fetch activities:', logErr);
            return res.status(500).json({ error: 'Failed to fetch request details' });
          }

          res.json({
            request,
            activities
          });
        }
      );
    }
  );
});

/**
 * POST /admin/requests/:id/assign
 * Assign a request to an agent
 */
router.post('/requests/:id/assign', requireRole('admin'), (req, res) => {
  const adminId = req.session.user.id;
  const requestId = Number(req.params.id);
  const { agentId } = req.body;

  // Validate input
  if (!Number.isInteger(requestId)) {
    return res.status(400).json({ error: 'Invalid request ID' });
  }

  if (!agentId || !Number.isInteger(Number(agentId))) {
    return res.status(400).json({ error: 'Valid agent ID is required' });
  }

  // Step 1: Validate agent exists and is active
  db.get(
    `SELECT id, name, active FROM users WHERE id = ? AND role = 'agent'`,
    [agentId],
    (err, agent) => {
      if (err) {
        console.error('Failed to fetch agent:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (!agent) {
        return res.status(400).json({ error: 'Agent not found' });
      }

      if (!agent.active) {
        return res.status(400).json({ error: 'Agent is not active' });
      }

      // Step 2: Check agent workload
      db.get(
        `SELECT COUNT(*) as active_count
         FROM requests
         WHERE agent_id = ? AND status IN ('assigned', 'in_progress')`,
        [agentId],
        (workloadErr, workload) => {
          if (workloadErr) {
            console.error('Failed to check workload:', workloadErr);
            return res.status(500).json({ error: 'Database error' });
          }

          if (workload.active_count >= 10) {
            return res.status(400).json({
              error: 'Agent has too many active requests. Please choose another agent.'
            });
          }

          // Step 3: Assign request
          db.run(
            `UPDATE requests
             SET status = 'assigned', agent_id = ?, updated_at = datetime('now')
             WHERE id = ? AND status = 'pending'`,
            [agentId, requestId],
            function (updateErr) {
              if (updateErr) {
                console.error('Failed to assign request:', updateErr);
                return res.status(500).json({ error: 'Failed to assign request' });
              }

              if (this.changes === 0) {
                // Check why assignment failed
                db.get(
                  'SELECT id, status FROM requests WHERE id = ?',
                  [requestId],
                  (checkErr, request) => {
                    if (checkErr || !request) {
                      return res.status(404).json({ error: 'Request not found' });
                    }
                    return res.status(400).json({
                      error: `Cannot assign request with status '${request.status}'`
                    });
                  }
                );
                return;
              }

              // Log activity
              logActivity(
                adminId,
                'assign_request',
                requestId,
                `Assigned request to agent ${agent.name} (ID: ${agentId})`,
                (logErr) => {
                  if (logErr) {
                    console.error('Failed to log activity:', logErr);
                  }
                }
              );

              res.json({
                success: true,
                message: `Request assigned to ${agent.name} successfully`
              });
            }
          );
        }
      );
    }
  );
});

/**
 * POST /admin/requests/:id/reassign
 * Reassign a request to a different agent
 */
router.post('/requests/:id/reassign', requireRole('admin'), (req, res) => {
  const adminId = req.session.user.id;
  const requestId = Number(req.params.id);
  const { agentId } = req.body;

  if (!Number.isInteger(requestId)) {
    return res.status(400).json({ error: 'Invalid request ID' });
  }

  if (!agentId || !Number.isInteger(Number(agentId))) {
    return res.status(400).json({ error: 'Valid agent ID is required' });
  }

  // Validate agent
  db.get(
    `SELECT id, name, active FROM users WHERE id = ? AND role = 'agent'`,
    [agentId],
    (err, agent) => {
      if (err) {
        console.error('Failed to fetch agent:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (!agent) {
        return res.status(400).json({ error: 'Agent not found' });
      }

      if (!agent.active) {
        return res.status(400).json({ error: 'Agent is not active' });
      }

      // Get current request info
      db.get(
        `SELECT r.id, r.status, r.agent_id, a.name as old_agent_name
         FROM requests r
         LEFT JOIN users a ON r.agent_id = a.id
         WHERE r.id = ?`,
        [requestId],
        (reqErr, request) => {
          if (reqErr) {
            console.error('Failed to fetch request:', reqErr);
            return res.status(500).json({ error: 'Database error' });
          }

          if (!request) {
            return res.status(404).json({ error: 'Request not found' });
          }

          if (!['assigned', 'in_progress'].includes(request.status)) {
            return res.status(400).json({
              error: `Cannot reassign ${request.status} request`
            });
          }

          // Reassign
          db.run(
            `UPDATE requests
             SET agent_id = ?, updated_at = datetime('now')
             WHERE id = ?`,
            [agentId, requestId],
            function (updateErr) {
              if (updateErr) {
                console.error('Failed to reassign request:', updateErr);
                return res.status(500).json({ error: 'Failed to reassign request' });
              }

              // Log activity
              logActivity(
                adminId,
                'reassign_request',
                requestId,
                `Reassigned from ${request.old_agent_name || 'unassigned'} to ${agent.name}`
              );

              res.json({
                success: true,
                message: `Request reassigned to ${agent.name} successfully`
              });
            }
          );
        }
      );
    }
  );
});

/**
 * GET /admin/dashboard/stats
 * Get dashboard statistics
 */
router.get('/dashboard/stats', requireRole('admin'), (req, res) => {
  const statsQuery = `
    SELECT
      (SELECT COUNT(*) FROM requests) as total_requests,
      (SELECT COUNT(*) FROM requests WHERE status = 'pending') as pending_requests,
      (SELECT COUNT(*) FROM requests WHERE status = 'assigned') as assigned_requests,
      (SELECT COUNT(*) FROM requests WHERE status = 'in_progress') as in_progress_requests,
      (SELECT COUNT(*) FROM requests WHERE status = 'completed') as completed_requests,
      (SELECT COUNT(*) FROM requests WHERE status = 'cancelled') as cancelled_requests,
      (SELECT COUNT(*) FROM users WHERE role = 'user') as total_users,
      (SELECT COUNT(*) FROM users WHERE role = 'agent') as total_agents,
      (SELECT COUNT(*) FROM users WHERE role = 'agent' AND active = 1) as active_agents
  `;

  db.get(statsQuery, [], (err, stats) => {
    if (err) {
      console.error('Failed to fetch stats:', err);
      return res.status(500).json({ error: 'Failed to fetch statistics' });
    }

    res.json(stats);
  });
});

module.exports = router;
