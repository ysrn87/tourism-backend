const db = require('../db/db');

async function migrateAgentToTourGuide() {
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');

    console.log('Starting migration: agent → tour_guide');

    // 1. Update CHECK constraint on users table
    await client.query(`
      ALTER TABLE users 
      DROP CONSTRAINT IF EXISTS users_role_check
    `);

    await client.query(`
      ALTER TABLE users 
      ADD CONSTRAINT users_role_check 
      CHECK (role IN ('user', 'tour_guide', 'admin'))
    `);

    // 2. Update existing agent roles to tour_guide
    const updateResult = await client.query(`
      UPDATE users 
      SET role = 'tour_guide' 
      WHERE role = 'agent'
    `);

    console.log(`✅ Updated ${updateResult.rowCount} users from 'agent' to 'tour_guide'`);

    // 3. Update activity_logs actor_role
    const activityResult = await client.query(`
      UPDATE activity_logs 
      SET actor_role = 'tour_guide' 
      WHERE actor_role = 'agent'
    `);

    console.log(`✅ Updated ${activityResult.rowCount} activity logs`);

    // 4. Rename agent_id column to tour_guide_id in requests table
    await client.query(`
      ALTER TABLE requests 
      RENAME COLUMN agent_id TO tour_guide_id
    `);

    console.log('✅ Renamed agent_id to tour_guide_id in requests table');

    // 5. Update indexes
    await client.query('DROP INDEX IF EXISTS idx_requests_agent_id');
    await client.query('CREATE INDEX idx_requests_tour_guide_id ON requests(tour_guide_id)');

    console.log('✅ Updated indexes');

    await client.query('COMMIT');
    console.log('✅ Migration completed successfully!');
    
    process.exit(0);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    client.release();
  }
}

migrateAgentToTourGuide();