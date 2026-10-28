// Creates the database if it does not exist, then applies the (idempotent) schema.
// Never drops anything — safe to run against a database that already has data.
const { Client } = require('pg');
const config = require('../src/config');

async function main() {
  if (!config.db.connectionString) {
    const admin = new Client({ ...config.db, database: process.env.DB_ADMIN_DATABASE || 'postgres' });
    await admin.connect();
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [config.db.database]);
    if (!rows.length) {
      await admin.query(`CREATE DATABASE "${config.db.database.replace(/"/g, '""')}"`);
      console.log(`✓ Created database ${config.db.database}`);
    } else {
      console.log(`✓ Database ${config.db.database} already exists`);
    }
    await admin.end();
  }
  const { pool } = require('../src/db');
  const { migrate } = require('../src/schema');
  await migrate(pool);
  console.log('✓ Schema is up to date');
  await pool.end();
}

main().catch((err) => {
  console.error('✗ Database initialisation failed:', err.message);
  process.exit(1);
});
