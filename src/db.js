const { Pool, types } = require('pg');
const config = require('./config');

// Return DATE columns as 'YYYY-MM-DD' strings instead of JS Dates shifted to local midnight.
types.setTypeParser(1082, (v) => v);

const pool = new Pool({ ...config.db, max: 20 });

pool.on('error', (err) => {
  console.error('Unexpected idle database client error:', err.message);
});

/**
 * Run fn(client) inside a transaction. Rolls back on any thrown error.
 * isolation: 'READ COMMITTED' (default) | 'REPEATABLE READ' | 'SERIALIZABLE'
 */
async function tx(fn, { isolation, readOnly } = {}) {
  const client = await pool.connect();
  try {
    let begin = 'BEGIN';
    if (isolation) begin += ` ISOLATION LEVEL ${isolation}`;
    if (readOnly) begin += ' READ ONLY';
    await client.query(begin);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection may be gone */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, tx };
