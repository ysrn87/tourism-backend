const express = require('express');
const pool = require('../db/db-postgres');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /user/bookings
 * Create new booking
 */
router.post('/', requireLogin, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { package_id, departure_date, num_travelers, notes } = req.body;

    // Validation
    if (!package_id || !departure_date || !num_travelers) {
      return res.status(400).json({ 
        error: 'Missing required fields: package_id, departure_date, num_travelers' 
      });
    }

    if (num_travelers < 1) {
      return res.status(400).json({ error: 'Number of travelers must be at least 1' });
    }

    // Check if package exists and has availability
    const packageResult = await pool.query(
      'SELECT * FROM tour_packages WHERE id = $1 AND active = true',
      [package_id]
    );

    if (packageResult.rows.length === 0) {
      return res.status(404).json({ error: 'Package not found or inactive' });
    }

    const pkg = packageResult.rows[0];

    if (pkg.seats_available < num_travelers) {
      return res.status(400).json({ 
        error: `Only ${pkg.seats_available} seats available` 
      });
    }

    // Calculate total price
    const total_price = pkg.price * num_travelers;

    // Create booking
    const result = await pool.query(
      `INSERT INTO tour_bookings (
        package_id, user_id, departure_date, num_travelers, 
        total_price, status, notes, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING id`,
      [package_id, userId, departure_date, num_travelers, total_price, notes]
    );

    const bookingId = result.rows[0].id;

    // Update package seats
    await pool.query(
      'UPDATE tour_packages SET seats_available = seats_available - $1 WHERE id = $2',
      [num_travelers, package_id]
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
 * GET /user/bookings
 * Get all user bookings
 */
router.get('/', requireLogin, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT 
        b.*,
        p.title as package_title,
        p.destination as package_destination,
        p.duration_days as package_duration_days,
        p.duration_nights as package_duration_nights,
        p.image_url as package_image_url
      FROM tour_bookings b
      INNER JOIN tour_packages p ON b.package_id = p.id
      WHERE b.user_id = $1
      ORDER BY b.created_at DESC
      LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    // Get total count
    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM tour_bookings WHERE user_id = $1',
      [userId]
    );

    res.json({
      bookings: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].total),
        totalPages: Math.ceil(parseInt(countResult.rows[0].total) / limit)
      }
    });
  } catch (error) {
    console.error('Failed to fetch bookings:', error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

/**
 * GET /user/bookings/:id
 * Get booking details
 */
router.get('/:id', requireLogin, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const bookingId = parseInt(req.params.id);

    const result = await pool.query(
      `SELECT 
        b.*,
        p.title as package_title,
        p.destination as package_destination,
        p.duration_days as package_duration_days,
        p.duration_nights as package_duration_nights,
        p.image_url as package_image_url,
        p.description as package_description,
        p.includes as package_includes,
        p.excludes as package_excludes
      FROM tour_bookings b
      INNER JOIN tour_packages p ON b.package_id = p.id
      WHERE b.id = $1 AND b.user_id = $2`,
      [bookingId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Failed to fetch booking:', error);
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

/**
 * PATCH /user/bookings/:id/cancel
 * Cancel booking
 */
router.patch('/:id/cancel', requireLogin, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const bookingId = parseInt(req.params.id);

    // Get booking
    const bookingResult = await pool.query(
      'SELECT * FROM tour_bookings WHERE id = $1 AND user_id = $2',
      [bookingId, userId]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];

    if (booking.status === 'cancelled') {
      return res.status(400).json({ error: 'Booking already cancelled' });
    }

    if (booking.status === 'completed') {
      return res.status(400).json({ error: 'Cannot cancel completed booking' });
    }

    // Cancel booking
    await pool.query(
      'UPDATE tour_bookings SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['cancelled', bookingId]
    );

    // Return seats to package
    await pool.query(
      'UPDATE tour_packages SET seats_available = seats_available + $1 WHERE id = $2',
      [booking.num_travelers, booking.package_id]
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

module.exports = router;