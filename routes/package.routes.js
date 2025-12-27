const express = require('express');
const pool = require('../db/db-postgres');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Helper function to generate slug
function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Helper function to log activity
function logActivity(adminId, action, note, callback) {
  pool.query(
    `INSERT INTO activity_logs (actor_id, actor_role, action, note, created_at)
     VALUES ($1, 'admin', $2, $3, CURRENT_TIMESTAMP)`,
    [adminId, action, note],
    callback || (() => {})
  );
}

/**
 * GET /packages
 * Get all tour packages (public)
 */
router.get('/', async (req, res) => {
  try {
    const { featured, destination, active = 'true' } = req.query;
    
    let query = 'SELECT * FROM tour_packages WHERE 1=1';
    let params = [];
    let paramCount = 1;

    if (active === 'true') {
      query += ` AND active = $${paramCount}`;
      params.push(true);
      paramCount++;
    }

    if (featured === 'true') {
      query += ` AND featured = $${paramCount}`;
      params.push(true);
      paramCount++;
    }

    if (destination) {
      query += ` AND destination ILIKE $${paramCount}`;
      params.push(`%${destination}%`);
      paramCount++;
    }

    query += ' ORDER BY featured DESC, created_at DESC';

    const result = await pool.query(query, params);
    res.json({ packages: result.rows });
  } catch (error) {
    console.error('Failed to fetch packages:', error);
    res.status(500).json({ error: 'Failed to fetch tour packages' });
  }
});

/**
 * GET /packages/:slug
 * Get single tour package by slug (public)
 */
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM tour_packages WHERE slug = $1 AND active = true',
      [slug]
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
 * POST /packages
 * Create new tour package (admin only)
 */
router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const {
      title,
      destination,
      description,
      image_url,
      price,
      duration_days,
      duration_nights,
      departure_days,
      seats_total,
      itinerary,
      includes,
      excludes,
      highlights,
      featured,
    } = req.body;

    // Validation
    if (!title || !destination || !price || !duration_days || !seats_total) {
      return res.status(400).json({ 
        error: 'Missing required fields: title, destination, price, duration_days, seats_total' 
      });
    }

    const slug = generateSlug(title);
    const seats_available = seats_total;

    const result = await pool.query(
      `INSERT INTO tour_packages (
        title, slug, destination, description, image_url, price,
        duration_days, duration_nights, departure_days, seats_available, seats_total,
        itinerary, includes, excludes, highlights, featured, active,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, true,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ) RETURNING id`,
      [
        title, slug, destination, description, image_url, price,
        duration_days, duration_nights || 0, departure_days,
        seats_available, seats_total,
        JSON.stringify(itinerary || []),
        JSON.stringify(includes || []),
        JSON.stringify(excludes || []),
        JSON.stringify(highlights || []),
        featured || false
      ]
    );

    const packageId = result.rows[0].id;

    // Log activity
    logActivity(
      req.session.user.id,
      'create_package',
      `Created tour package: ${title} (ID: ${packageId})`
    );

    res.status(201).json({
      success: true,
      packageId,
      message: 'Tour package created successfully'
    });
  } catch (error) {
    console.error('Failed to create package:', error);
    
    if (error.code === '23505') { // Duplicate slug
      return res.status(400).json({ error: 'A package with this title already exists' });
    }
    
    res.status(500).json({ error: 'Failed to create package' });
  }
});

/**
 * PUT /packages/:id
 * Update tour package (admin only)
 */
router.put('/:id', requireRole('admin'), async (req, res) => {
  try {
    const packageId = parseInt(req.params.id);
    const {
      title,
      destination,
      description,
      image_url,
      price,
      duration_days,
      duration_nights,
      departure_days,
      seats_available,
      seats_total,
      itinerary,
      includes,
      excludes,
      highlights,
      featured,
      active
    } = req.body;

    // Check if package exists
    const checkResult = await pool.query(
      'SELECT id, title FROM tour_packages WHERE id = $1',
      [packageId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Package not found' });
    }

    const slug = title ? generateSlug(title) : undefined;

    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (title !== undefined) {
      updates.push(`title = $${paramCount}`);
      values.push(title);
      paramCount++;
      updates.push(`slug = $${paramCount}`);
      values.push(slug);
      paramCount++;
    }
    if (destination !== undefined) {
      updates.push(`destination = $${paramCount}`);
      values.push(destination);
      paramCount++;
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount}`);
      values.push(description);
      paramCount++;
    }
    if (image_url !== undefined) {
      updates.push(`image_url = $${paramCount}`);
      values.push(image_url);
      paramCount++;
    }
    if (price !== undefined) {
      updates.push(`price = $${paramCount}`);
      values.push(price);
      paramCount++;
    }
    if (duration_days !== undefined) {
      updates.push(`duration_days = $${paramCount}`);
      values.push(duration_days);
      paramCount++;
    }
    if (duration_nights !== undefined) {
      updates.push(`duration_nights = $${paramCount}`);
      values.push(duration_nights);
      paramCount++;
    }
    if (departure_days !== undefined) {
      updates.push(`departure_days = $${paramCount}`);
      values.push(departure_days);
      paramCount++;
    }
    if (seats_available !== undefined) {
      updates.push(`seats_available = $${paramCount}`);
      values.push(seats_available);
      paramCount++;
    }
    if (seats_total !== undefined) {
      updates.push(`seats_total = $${paramCount}`);
      values.push(seats_total);
      paramCount++;
    }
    if (itinerary !== undefined) {
      updates.push(`itinerary = $${paramCount}`);
      values.push(JSON.stringify(itinerary));
      paramCount++;
    }
    if (includes !== undefined) {
      updates.push(`includes = $${paramCount}`);
      values.push(JSON.stringify(includes));
      paramCount++;
    }
    if (excludes !== undefined) {
      updates.push(`excludes = $${paramCount}`);
      values.push(JSON.stringify(excludes));
      paramCount++;
    }
    if (highlights !== undefined) {
      updates.push(`highlights = $${paramCount}`);
      values.push(JSON.stringify(highlights));
      paramCount++;
    }
    if (featured !== undefined) {
      updates.push(`featured = $${paramCount}`);
      values.push(featured);
      paramCount++;
    }
    if (active !== undefined) {
      updates.push(`active = $${paramCount}`);
      values.push(active);
      paramCount++;
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);

    values.push(packageId);

    const updateQuery = `
      UPDATE tour_packages 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
    `;

    await pool.query(updateQuery, values);

    // Log activity
    logActivity(
      req.session.user.id,
      'update_package',
      `Updated tour package: ${title || checkResult.rows[0].title} (ID: ${packageId})`
    );

    res.json({
      success: true,
      message: 'Package updated successfully'
    });
  } catch (error) {
    console.error('Failed to update package:', error);
    
    if (error.code === '23505') {
      return res.status(400).json({ error: 'A package with this title already exists' });
    }
    
    res.status(500).json({ error: 'Failed to update package' });
  }
});

/**
 * DELETE /packages/:id
 * Delete tour package (admin only)
 */
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const packageId = parseInt(req.params.id);

    // Check if package exists
    const checkResult = await pool.query(
      'SELECT id, title FROM tour_packages WHERE id = $1',
      [packageId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Package not found' });
    }

    const packageTitle = checkResult.rows[0].title;

    // Delete package (bookings will be cascade deleted)
    await pool.query('DELETE FROM tour_packages WHERE id = $1', [packageId]);

    // Log activity
    logActivity(
      req.session.user.id,
      'delete_package',
      `Deleted tour package: ${packageTitle} (ID: ${packageId})`
    );

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
 * PATCH /packages/:id/toggle-featured
 * Toggle featured status (admin only)
 */
router.patch('/:id/toggle-featured', requireRole('admin'), async (req, res) => {
  try {
    const packageId = parseInt(req.params.id);

    const result = await pool.query(
      'SELECT id, title, featured FROM tour_packages WHERE id = $1',
      [packageId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Package not found' });
    }

    const pkg = result.rows[0];
    const newFeatured = !pkg.featured;

    await pool.query(
      'UPDATE tour_packages SET featured = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newFeatured, packageId]
    );

    res.json({
      success: true,
      featured: newFeatured,
      message: `Package ${newFeatured ? 'featured' : 'unfeatured'} successfully`
    });
  } catch (error) {
    console.error('Failed to toggle featured:', error);
    res.status(500).json({ error: 'Failed to update package' });
  }
});

module.exports = router;