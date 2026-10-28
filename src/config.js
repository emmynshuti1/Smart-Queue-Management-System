require('dotenv').config();
const crypto = require('crypto');

const isProduction = process.env.NODE_ENV === 'production';

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  if (isProduction) {
    throw new Error('JWT_SECRET must be set (at least 32 characters) in production');
  }
  // Dev fallback: random per process, so tokens never survive a restart with a guessable secret.
  jwtSecret = crypto.randomBytes(48).toString('hex');
  console.warn('⚠ JWT_SECRET missing or too short — using a random development secret');
}

module.exports = {
  isProduction,
  port: parseInt(process.env.PORT, 10) || 5000,
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  frontendUrl: process.env.FRONTEND_URL || null,
  adminInitialPassword: process.env.ADMIN_INITIAL_PASSWORD || null,
  db: process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
      }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT, 10) || 5432,
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'sqhs_db',
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
      },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_PHONE_NUMBER || ''
  }
};
