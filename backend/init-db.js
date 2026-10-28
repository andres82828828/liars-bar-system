// Creates the "liars_bar" database (if it does not exist) and runs database/liars_bar.sql
// WARNING: it drops and recreates every table (all data is lost).
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { config } = require('./db');

const DB_NAME = process.env.DB_NAME || 'liars_bar';

(async () => {
  try {
    // 1) Connect to the "postgres" database to be able to create ours
    const admin = new Client({ ...config, database: 'postgres' });
    await admin.connect();
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${DB_NAME}"`);
      console.log(`✔ Database "${DB_NAME}" created`);
    } else {
      console.log(`• Database "${DB_NAME}" already existed (its tables will be reset)`);
    }
    await admin.end();

    // 2) Run the tables + seed data script. The old Spanish tables are dropped too.
    const sql = fs.readFileSync(path.join(__dirname, '..', 'database', 'liars_bar.sql'), 'utf8');
    const db = new Client({ ...config, database: DB_NAME });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS factura, pago, detalle_pedido, pedido, producto_sede, producto,
                    tipo_producto, proveedor, log_trazabilidad, usuario, mesa, sede CASCADE`);
    await db.query(sql);
    await db.end();
    console.log('✔ Tables and seed data loaded');
  } catch (err) {
    console.error('✖ Error:', err.message);
    if (err.code === '28P01') console.error('  → The PostgreSQL password in backend/.env is wrong.');
    if (err.code === 'ECONNREFUSED') console.error('  → PostgreSQL is not running or the port is not the one in backend/.env.');
    process.exit(1);
  }
})();
