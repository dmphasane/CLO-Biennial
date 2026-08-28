// Initialise the database schema and seed the 3 users.
// Run once after setting up your database: npm run initdb
import fs from 'fs';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import dotenv from 'dotenv';
dotenv.config();

async function main(){
  console.log('Creating schema…');
  const schema = fs.readFileSync('./schema.sql', 'utf8');
  await pool.query(schema);
  console.log('Schema created.');

  const users = [
    { username:'treasurer', name:'Ms Given Phusoane', role:'Treasurer', pass: process.env.TREASURER_PASSWORD || 'Treasurer@2027' },
    { username:'financial_secretary', name:'Mr Dumisani Mphasane', role:'Financial Secretary', pass: process.env.FINSEC_PASSWORD || 'FinSec@2027' },
    { username:'recording_secretary', name:'Ms Poppy Kareli', role:'Recording Secretary', pass: process.env.RECSEC_PASSWORD || 'RecSec@2027' },
  ];

  for(const u of users){
    const hash = await bcrypt.hash(u.pass, 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (username) DO UPDATE SET password_hash=$2, full_name=$3, role=$4`,
      [u.username, hash, u.name, u.role]
    );
    console.log('Seeded user:', u.username);
  }

  console.log('Done. You can now start the server with: npm start');
  await pool.end();
}

main().catch(e=>{ console.error(e); process.exit(1); });
