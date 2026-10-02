import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

// Works with Supabase, Render, Neon — all require SSL.
// Supabase: use the "Session pooler" or "Transaction pooler" connection string.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 15000,
  keepAlive: true,
  // Supabase poolers can be strict; allow a bit more statement time
  statement_timeout: 20000,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err.message);
});

// Query with a single retry — handles transient Supabase connection drops
export async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (e) {
    if (e.code === 'ECONNREFUSED' || e.message?.includes('AggregateError') || e.name === 'AggregateError' || e.code === 'ETIMEDOUT') {
      console.warn('DB query failed, retrying once:', e.message);
      await new Promise(r => setTimeout(r, 1000));
      return await pool.query(text, params);
    }
    throw e;
  }
}
