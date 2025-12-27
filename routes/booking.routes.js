const express = require('express');
const pool = require('../db/db-postgres');
const { requireLogin, requireRole } = require('../middleware/auth');

const router = express.Router();

// Helper function to log activity
function logActivity(userId, userRole, action, note, callback) {
  pool.query(
    `INSERT INTO activity_logs (actor_id, actor_role, action, note, created_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
    [userId, userRole, action, note],
    callback || (() => {})
  );
}

/**
 * POST /bookings
 * Create a new booking (user only)
 */
router.post('/', requireLogin, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const {
      package_id,
      departure_date,
      num_travelers,
      contact_name,
      contact_email,
      contact_phone,
      special_requests
    } = req.body;

    // Validation
    if (!package_id || !departure_date || !num_travelers || !contact_name || !contact_email || !contact_phone) {
      return res.status(400).json({ 
        error: 'Missing required fields' 
      });
    }

    if (num_travelers < 1) {
      return res.status(400).json({ error: 'Number of travelers must be at least 1' });
    }

    // Check if package exists and has availability
    const pkgResult = await pool.query(
      'SELECT id, title, price, seats_available, active FROM tour_packages WHERE id = $1',
      [package_id]
    );

    if (pkgResult.rows.length === 0) {
      return res.status(404).json({ error: 'Package not found' });
    }

    const pkg = pkgResult.rows[0];

    if (!pkg.active) {
      return res.status(400).json({ error: 'This package is no longer available' });
    }

    if (pkg.seats_available < num_travelers) {
      return res.status(400).json({ 
        error: `Only ${pkg.seats_available} seats available` 
      });
    }

    // Calculate total price
    const total_price = pkg.price * num_travelers;

    // Create booking
    const bookingResult = await pool.query(
      `INSERT INTO tour_bookings (
        package_id, user_id, departure_date, num_travelers, total_price,
        contact_name, contact_email, contact_phone, special_requests,
        status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING id`,
      [
        package_id, userId, departure_date, num_travelers, total_price,
        contact_name, contact_email, contact_phone, special_requests
      ]
    );

    const bookingId = bookingResult.rows[0].id;

    // Update seats availability
    await pool.query(
      'UPDATE tour_packages SET seats_available = seats_available - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [num_travelers, package_id]
    );

    // Log activity
    logActivity(
      userId,
      'user',
      'create_booking',
      `Booked ${pkg.title} for ${num_travelers} travelers`
    );

    res.status(201).json({
      success: true,
      bookingId,
      message: 'Booking created successfully'
    });
  } catch (error) {
    console.error('Failed to create booking:', error);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

/**
 * GET /bookings/my-bookings
 * Get user's bookings
 */
router.get('/my-bookings', requireLogin, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const result = await pool.query(
      `SELECT 
        b.*,
        p.title as package_title,
        p.destination,
        p.duration_days,
        p.duration_nights,
        p.image_url
      FROM tour_bookings b
      JOIN tour_packages p ON b.package_id = p.id
      WHERE b.user_id = $1
      ORDER BY b.created_at DESC`,
      [userId]
    );

    res.json({ bookings: result.rows });
  } catch (error) {
    console.error('Failed to fetch bookings:', error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

/**
 * GET /bookings/:id
 * Get booking details
 */
router.get('/:id', requireLogin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);
    const userId = req.session.user.id;
    const userRole = req.session.user.role;

    const result = await pool.query(
      `SELECT 
        b.*,
        p.title as package_title,
        p.destination,
        p.description,
        p.duration_days,
        p.duration_nights,
        p.image_url,
        p.includes,
        p.excludes,
        u.name as user_name,
        u.email as user_email
      FROM tour_bookings b
      JOIN tour_packages p ON b.package_id = p.id
      JOIN users u ON b.user_id = u.id
      WHERE b.id = $1`,
      [bookingId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = result.rows[0];

    // Check permission (user can only see their own bookings, admin/agent can see all)
    if (userRole === 'user' && booking.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json(booking);
  } catch (error) {
    console.error('Failed to fetch booking:', error);
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

/**
 * PATCH /bookings/:id/cancel
 * Cancel a booking (user only, only pending bookings)
 */
router.patch('/:id/cancel', requireLogin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);
    const userId = req.session.user.id;

    // Get booking details
    const bookingResult = await pool.query(
      'SELECT id, user_id, package_id, num_travelers, status FROM tour_bookings WHERE id = $1',
      [bookingId]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];

    // Check permission
    if (booking.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Can only cancel pending bookings
    if (booking.status !== 'pending') {
      return res.status(400).json({ 
        error: `Cannot cancel ${booking.status} booking` 
      });
    }

    // Update booking status
    await pool.query(
      'UPDATE tour_bookings SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['cancelled', bookingId]
    );

    // Return seats to availability
    await pool.query(
      'UPDATE tour_packages SET seats_available = seats_available + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [booking.num_travelers, booking.package_id]
    );

    // Log activity
    logActivity(
      userId,
      'user',
      'cancel_booking',
      `Cancelled booking #${bookingId}`
    );

    res.json({
      success: true,
      message: 'Booking cancelled successfully'
    });
  } catch (error) {
    console.error('Failed to cancel booking:', error);
    res.status(500).json({ error: 'Failed to cancel booking' });
  }
});

/**
 * GET /bookings/admin/all
 * Get all bookings (admin only)
 */
router.get('/admin/all', requireRole('admin'), async (req, res) => {
  try {
    const { status } = req.query;

    let query = `
      SELECT 
        b.*,
        p.title as package_title,
        p.destination,
        u.name as user_name,
        u.email as user_email
      FROM tour_bookings b
      JOIN tour_packages p ON b.package_id = p.id
      JOIN users u ON b.user_id = u.id
      WHERE 1=1
    `;
    
    const params = [];

    if (status && ['pending', 'confirmed', 'cancelled', 'completed'].includes(status)) {
      query += ' AND b.status = $1';
      params.push(status);
    }

    query += ' ORDER BY b.created_at DESC';

    const result = await pool.query(query, params);

    res.json({ bookings: result.rows });
  } catch (error) {
    console.error('Failed to fetch bookings:', error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

/**
 * PATCH /bookings/:id/status
 * Update booking status (admin only)
 */
router.patch('/:id/status', requireRole('admin'), async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);
    const { status } = req.body;

    if (!['pending', 'confirmed', 'cancelled', 'completed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const result = await pool.query(
      'UPDATE tour_bookings SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id',
      [status, bookingId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Log activity
    logActivity(
      req.session.user.id,
      'admin',
      'update_booking_status',
      `Updated booking #${bookingId} to ${status}`
    );

    res.json({
      success: true,
      message: 'Booking status updated successfully'
    });
  } catch (error) {
    console.error('Failed to update booking:', error);
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

module.exports = router;