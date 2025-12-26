require('dotenv').config();
const { Pool } = require('pg');

// Use DATABASE_URL from Railway environment variable
const connectionString = process.env.DATABASE_URL || process.env.DB_CONNECTION_STRING;

if (!connectionString) {
  console.error('❌ DATABASE_URL environment variable is not set!');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: false
  } : false,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
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
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // USERS TABLE
    await client.query(`
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
    await client.query(`
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
    await client.query(`
      CREATE TABLE IF NOT EXISTS requests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        destination VARCHAR(255) NOT NULL,
        message TEXT,
        status VARCHAR(20) DEFAULT 'pending' CHECK(status IN ('pending', 'assigned', 'in_progress', 'completed', 'cancelled')),
        tour_guide_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // PACKAGES TABLE
    await client.query(`
      CREATE TABLE IF NOT EXISTS packages (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        destination VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10, 2) NOT NULL,
        duration_days INTEGER NOT NULL,
        max_seats INTEGER NOT NULL,
        available_seats INTEGER NOT NULL,
        image_url VARCHAR(500),
        includes TEXT,
        excludes TEXT,
        itinerary TEXT,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // PAYMENT PROOFS TABLE
    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_proofs (
        id SERIAL PRIMARY KEY,
        request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        file_name VARCHAR(255) NOT NULL,
        file_path VARCHAR(500) NOT NULL,
        file_size INTEGER,
        mime_type VARCHAR(100),
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ACTIVITY LOGS TABLE
    await client.query(`
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

    // Create indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_requests_user_id ON requests(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_requests_agent_id ON requests(agent_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_request_id ON activity_logs(request_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_destinations_slug ON destinations(slug)');

    // Add indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_packages_destination ON packages(destination)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_packages_active ON packages(active)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_payment_proofs_request_id ON payment_proofs(request_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_payment_proofs_user_id ON payment_proofs(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_requests_tour_guide_id ON requests(tour_guide_id)');
    
    await client.query('COMMIT');
    console.log('✅ PostgreSQL tables initialized');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error initializing tables:', error);
    throw error;
  } finally {
    client.release();
  }
};

// Initialize on startup
initializeTables().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

module.exports = pool;