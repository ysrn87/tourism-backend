const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db/db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/payment-proofs';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'payment-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Only images (JPEG, PNG) and PDF files are allowed'));
    }
  }
});

/**
 * POST /payment/upload
 * Upload payment proof for a request
 */
router.post('/upload', requireLogin, upload.single('payment_proof'), async (req, res) => {
  const userId = req.session.user.id;
  const { request_id } = req.body;

  if (!request_id) {
    return res.status(400).json({ error: 'Request ID is required' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Payment proof file is required' });
  }

  try {
    // Verify request belongs to user
    const requestCheck = await db.query(
      'SELECT id FROM requests WHERE id = $1 AND user_id = $2',
      [request_id, userId]
    );

    if (requestCheck.rows.length === 0) {
      // Delete uploaded file
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Request not found' });
    }

    // Save payment proof record
    const result = await db.query(
      `INSERT INTO payment_proofs (request_id, user_id, file_name, file_path, file_size, mime_type, uploaded_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       RETURNING *`,
      [request_id, userId, req.file.originalname, req.file.path, req.file.size, req.file.mimetype]
    );

    res.status(201).json({
      success: true,
      payment_proof: result.rows[0],
      message: 'Payment proof uploaded successfully'
    });
  } catch (error) {
    console.error('Failed to upload payment proof:', error);
    // Delete uploaded file on error
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Failed to upload payment proof' });
  }
});

/**
 * GET /payment/request/:requestId
 * Get payment proof for a request
 */
router.get('/request/:requestId', requireLogin, async (req, res) => {
  const requestId = Number(req.params.requestId);
  const userId = req.session.user.id;

  if (!Number.isInteger(requestId)) {
    return res.status(400).json({ error: 'Invalid request ID' });
  }

  try {
    const result = await db.query(
      `SELECT pp.* FROM payment_proofs pp
       INNER JOIN requests r ON pp.request_id = r.id
       WHERE pp.request_id = $1 AND (r.user_id = $2 OR r.agent_id = $2)`,
      [requestId, userId]
    );

    res.json({ payment_proofs: result.rows });
  } catch (error) {
    console.error('Failed to fetch payment proof:', error);
    res.status(500).json({ error: 'Failed to fetch payment proof' });
  }
});

module.exports = router;