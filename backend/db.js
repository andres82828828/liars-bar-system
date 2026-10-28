require('dotenv').config();
const { Pool } = require('pg');

const config = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
};

const pool = new Pool({ ...config, database: process.env.DB_NAME || 'liars_bar' });

module.exports = { pool, config };
