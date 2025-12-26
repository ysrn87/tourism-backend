const express = require('express');
const db = require('../db/db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /packages
 * Get all active packages (public)
 */
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT 
        id, name, destination, description, price, duration_days,
        max_seats, available_seats, image_url, includes, excludes,
        active, created_at, updated_at
       FROM packages
       WHERE active = true
       ORDER BY created_at DESC`
    );

    res.json({ packages: result.rows });
  } catch (error) {
    console.error('Failed to fetch packages:', error);
    res.status(500).json({ error: 'Failed to fetch packages' });
  }
});

/**
 * GET /packages/:id
 * Get package details (public)
 */
router.get('/:id', async (req, res) => {
  const packageId = Number(req.params.id);

  if (!Number.isInteger(packageId)) {
    return res.status(400).json({ error: 'Invalid package ID' });
  }

  try {
    const result = await db.query(
      `SELECT * FROM packages WHERE id = $1`,
      [packageId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Package not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Failed to fetch package:', error);
    res.status(500).json({ error: 'Failed to fetch package' });
  }
});

/**
 * GET /admin/packages
 * Get all packages (admin only)
 */
router.get('/admin/all', requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM packages ORDER BY created_at DESC`
    );

    res.json({ packages: result.rows });
  } catch (error) {
    console.error('Failed to fetch packages:', error);
    res.status(500).json({ error: 'Failed to fetch packages' });
  }
});

/**
 * POST /admin/packages
 * Create new package (admin only)
 */
router.post('/admin/create', requireRole('admin'), async (req, res) => {
  const {
    name, destination, description, price, duration_days,
    max_seats, image_url, includes, excludes, itinerary
  } = req.body;

  // Validation
  if (!name || !destination || !price || !duration_days || !max_seats) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const result = await db.query(
      `INSERT INTO packages (
        name, destination, description, price, duration_days,
        max_seats, available_seats, image_url, includes, excludes, 
        itinerary, active, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *`,
      [name, destination, description, price, duration_days, max_seats, 
       image_url, includes, excludes, itinerary]
    );

    res.status(201).json({
      success: true,
      package: result.rows[0],
      message: 'Package created successfully'
    });
  } catch (error) {
    console.error('Failed to create package:', error);
    res.status(500).json({ error: 'Failed to create package' });
  }
});

/**
 * PUT /admin/packages/:id
 * Update package (admin only)
 */
router.put('/admin/update/:id', requireRole('admin'), async (req, res) => {
  const packageId = Number(req.params.id);
  const {
    name, destination, description, price, duration_days,
    max_seats, available_seats, image_url, includes, excludes, 
    itinerary, active
  } = req.body;

  if (!Number.isInteger(packageId)) {
    return res.status(400).json({ error: 'Invalid package ID' });
  }

  try {
    const result = await db.query(
      `UPDATE packages SET
        name = $1, destination = $2, description = $3, price = $4,
        duration_days = $5, max_seats = $6, available_seats = $7,
        image_url = $8, includes = $9, excludes = $10, itinerary = $11,
        active = $12, updated_at = CURRENT_TIMESTAMP
       WHERE id = $13
       RETURNING *`,
      [name, destination, description, price, duration_days, max_seats,
       available_seats, image_url, includes, excludes, itinerary, active, packageId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Package not found' });
    }

    res.json({
      success: true,
      package: result.rows[0],
      message: 'Package updated successfully'
    });
  } catch (error) {
    console.error('Failed to update package:', error);
    res.status(500).json({ error: 'Failed to update package' });
  }
});

/**
 * DELETE /admin/packages/:id
 * Delete package (admin only)
 */
router.delete('/admin/delete/:id', requireRole('admin'), async (req, res) => {
  const packageId = Number(req.params.id);

  if (!Number.isInteger(packageId)) {
    return res.status(400).json({ error: 'Invalid package ID' });
  }

  try {
    const result = await db.query(
      'DELETE FROM packages WHERE id = $1 RETURNING id',
      [packageId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Package not found' });
    }

    res.json({
      success: true,
      message: 'Package deleted successfully'
    });
  } catch (error) {
    console.error('Failed to delete package:', error);
    res.status(500).json({ error: 'Failed to delete package' });
  }
});

/**
 * PATCH /admin/packages/:id/toggle-active
 * Toggle package active status (admin only)
 */
router.patch('/admin/toggle-active/:id', requireRole('admin'), async (req, res) => {
  const packageId = Number(req.params.id);

  if (!Number.isInteger(packageId)) {
    return res.status(400).json({ error: 'Invalid package ID' });
  }

  try {
    const checkResult = await db.query(
      'SELECT active FROM packages WHERE id = $1',
      [packageId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Package not found' });
    }

    const newStatus = !checkResult.rows[0].active;

    await db.query(
      'UPDATE packages SET active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newStatus, packageId]
    );

    res.json({
      success: true,
      active: newStatus,
      message: `Package ${newStatus ? 'activated' : 'deactivated'} successfully`
    });
  } catch (error) {
    console.error('Failed to toggle package status:', error);
    res.status(500).json({ error: 'Failed to update package' });
  }
});

module.exports = router;