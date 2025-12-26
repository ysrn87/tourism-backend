const { Pool } = require('pg');

// Use DATABASE_URL from Railway environment variable
const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: false
  } : false
});

// Test connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ PostgreSQL connection error:', err);
    process.exit(1);
  } else {
    console.log('✅ PostgreSQL connected at:', res.rows[0].now);
  }
});

// Initialize tables
const initializeTables = async () => {
  try {
    // Enable UUID extension (optional but useful)
    await pool.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

    // USERS TABLE
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        phone VARCHAR(20) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL CHECK(role IN ('user', 'tour_guide', 'admin')),
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // DESTINATIONS TABLE
    await pool.query(`
      CREATE TABLE IF NOT EXISTS destinations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        slug VARCHAR(255) NOT NULL UNIQUE,
        description TEXT,
        image_url VARCHAR(500),
        country VARCHAR(100),
        popular BOOLEAN DEFAULT FALSE,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // REQUESTS TABLE
    await pool.query(`
      CREATE TABLE IF NOT EXISTS requests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        destination VARCHAR(255) NOT NULL,
        message TEXT,
        status VARCHAR(20) DEFAULT 'pending' CHECK(status IN ('pending', 'assigned', 'in_progress', 'completed', 'cancelled')),
        tour_guide_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ACTIVITY LOGS TABLE
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        actor_role VARCHAR(20) NOT NULL,
        action VARCHAR(100) NOT NULL,
        request_id INTEGER REFERENCES requests(id) ON DELETE CASCADE,
        from_status VARCHAR(20),
        to_status VARCHAR(20),
        note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for better performance
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_requests_user_id ON requests(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_requests_tour_guide_id ON requests(tour_guide_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_request_id ON activity_logs(request_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_destinations_slug ON destinations(slug)');

    console.log('✅ PostgreSQL tables initialized');
  } catch (error) {
    console.error('❌ Error initializing tables:', error);
    process.exit(1);
  }
};

// Initialize on startup
initializeTables();

module.exports = pool;