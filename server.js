const { start } = require('./src/app');
const { pool } = require('./src/db');

start().catch((err) => {
  console.error('✗ SQHS failed to start:', err.message);
  if (err.code === 'ECONNREFUSED' || err.code === '3D000' || err.code === '28P01') {
    console.error('  Check the database settings in .env and run `npm run db:init` to create the database.');
  }
  pool.end().finally(() => process.exit(1));
});
