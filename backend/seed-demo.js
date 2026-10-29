// Fills the database with demo data: more tables, staff, products, inventory and
// ~45 days of sales (closed orders with payment, invoice and invoice_detail), plus a few open orders.
// It only ADDS data (it never deletes) and runs once: a second run does nothing (use --force to add more sales).
//   npm run seed-demo
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

const DAYS = 45;
const TABLES_PER_BRANCH = 8;
const MARKER = 'Demo data loaded';

const SUPPLIERS = ['Distribuidora Andina', 'Licores del Valle', 'Bavaria S.A.', 'Postobón', 'Alimentos La Parrilla'];
const TYPES = ['Licor', 'Cerveza', 'Cocteles', 'Comida', 'Bebidas sin alcohol'];

// code, name, type, supplier, purchase price, sale price, popularity (how often it is ordered)
const PRODUCTS = [
  ['LIC-001', 'Aguardiente Antioqueño (media)', 'Licor', 'Licores del Valle', 28000, 55000, 4],
  ['LIC-002', 'Ron Medellín 8 años (media)', 'Licor', 'Licores del Valle', 38000, 75000, 2],
  ['LIC-003', 'Whisky Old Parr (trago)', 'Licor', 'Licores del Valle', 9000, 22000, 2],
  ['LIC-004', 'Tequila José Cuervo (trago)', 'Licor', 'Licores del Valle', 6000, 16000, 3],
  ['LIC-005', 'Shot de aguardiente', 'Licor', 'Licores del Valle', 2500, 7000, 4],
  ['CER-001', 'Cerveza Club Colombia', 'Cerveza', 'Bavaria S.A.', 3500, 12000, 9],
  ['CER-002', 'Cerveza Águila', 'Cerveza', 'Bavaria S.A.', 2500, 8000, 8],
  ['CER-003', 'Cerveza Poker', 'Cerveza', 'Bavaria S.A.', 2500, 8000, 6],
  ['CER-004', 'Cerveza Corona', 'Cerveza', 'Bavaria S.A.', 4500, 14000, 5],
  ['CER-005', 'Cerveza artesanal BBC', 'Cerveza', 'Bavaria S.A.', 5500, 16000, 3],
  ['CER-006', 'Michelada', 'Cerveza', 'Bavaria S.A.', 4500, 15000, 5],
  ['COC-001', 'Mojito', 'Cocteles', 'Licores del Valle', 6000, 24000, 5],
  ['COC-002', 'Margarita', 'Cocteles', 'Licores del Valle', 7000, 26000, 3],
  ['COC-003', 'Piña colada', 'Cocteles', 'Licores del Valle', 7500, 27000, 3],
  ['COC-004', 'Cuba libre', 'Cocteles', 'Licores del Valle', 6000, 22000, 3],
  ['COC-005', 'Gin tonic', 'Cocteles', 'Licores del Valle', 8000, 28000, 3],
  ['COC-006', "Liar's Shot (de la casa)", 'Cocteles', 'Licores del Valle', 5000, 18000, 4],
  ['COM-001', 'Nachos con queso', 'Comida', 'Distribuidora Andina', 7000, 22000, 5],
  ['COM-002', 'Alitas BBQ (8 und.)', 'Comida', 'Alimentos La Parrilla', 12000, 32000, 4],
  ['COM-003', 'Papas a la francesa', 'Comida', 'Alimentos La Parrilla', 4000, 14000, 5],
  ['COM-004', 'Picada para 2', 'Comida', 'Alimentos La Parrilla', 18000, 48000, 3],
  ['COM-005', 'Empanadas (6 und.)', 'Comida', 'Distribuidora Andina', 6000, 18000, 3],
  ['COM-006', 'Patacones con hogao', 'Comida', 'Distribuidora Andina', 5000, 16000, 3],
  ['BSA-001', 'Gaseosa', 'Bebidas sin alcohol', 'Postobón', 1800, 6000, 4],
  ['BSA-002', 'Agua', 'Bebidas sin alcohol', 'Postobón', 1200, 5000, 3],
  ['BSA-003', 'Limonada de coco', 'Bebidas sin alcohol', 'Postobón', 3500, 12000, 3],
  ['BSA-004', 'Red Bull', 'Bebidas sin alcohol', 'Postobón', 4500, 12000, 3]
];

// Staff per branch (by branch name). Passwords: Cajero123* / Mesero123*
const STAFF = [
  ['Zona T', 'jrodriguez', 'Julián Rodríguez', 'Waiter'],
  ['Zona T', 'mtorres', 'Mariana Torres', 'Waiter'],
  ['Modelia', 'dsuarez', 'Daniela Suárez', 'Cashier'],
  ['Modelia', 'kmorales', 'Kevin Morales', 'Waiter'],
  ['Galerías', 'vcastro', 'Valentina Castro', 'Cashier'],
  ['Galerías', 'sramirez', 'Santiago Ramírez', 'Waiter'],
  ['Galerías', 'fortiz', 'Felipe Ortiz', 'Waiter']
];
const PASSWORDS = { Cashier: 'Cajero123*', Waiter: 'Mesero123*' };

const rnd = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pickWeighted = (items) => {
  let r = Math.random() * items.reduce((s, x) => s + x.weight, 0);
  for (const x of items) { r -= x.weight; if (r <= 0) return x; }
  return items[items.length - 1];
};
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

async function idByName(c, table, idCol, name) {
  const found = await c.query(`SELECT ${idCol} AS id FROM ${table} WHERE lower(nombre) = lower($1)`, [name]);
  if (found.rowCount) return found.rows[0].id;
  return (await c.query(`INSERT INTO ${table} (nombre) VALUES ($1) RETURNING ${idCol} AS id`, [name])).rows[0].id;
}

(async () => {
  const force = process.argv.includes('--force');
  const c = await pool.connect();
  try {
    const done = await c.query('SELECT 1 FROM log_trazabilidad WHERE operacion LIKE $1 LIMIT 1', [MARKER + '%']);
    if (done.rowCount && !force) {
      console.log('• Demo data was already loaded. Run "npm run seed-demo -- --force" to add more sales.');
      return;
    }
    await c.query('BEGIN');

    const admin = (await c.query(`SELECT id_usuario AS user_id FROM usuario WHERE rol = 'Administrator' ORDER BY id_usuario LIMIT 1`)).rows[0];
    if (!admin) throw new Error('There is no Administrator user: run "npm run init-db" first.');
    const branches = (await c.query('SELECT id_sede AS branch_id, nombre AS name FROM sede WHERE activo ORDER BY id_sede')).rows;

    // 1) Tables: every branch gets up to TABLES_PER_BRANCH
    for (const b of branches) {
      for (let n = 1; n <= TABLES_PER_BRANCH; n++) {
        await c.query(`INSERT INTO mesa (id_sede, numero) VALUES ($1, $2) ON CONFLICT (id_sede, numero) DO NOTHING`, [b.branch_id, n]);
      }
    }

    // 2) Staff
    for (const [branchName, username, fullName, role] of STAFF) {
      const b = branches.find((x) => x.name === branchName);
      if (!b) continue;
      await c.query(`INSERT INTO usuario (id_sede, username, password_hash, nombre_completo, rol) VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (username) DO NOTHING`, [b.branch_id, username, bcrypt.hashSync(PASSWORDS[role], 10), fullName, role]);
    }

    // 3) Catalog: suppliers, types and products (an existing product with the same code or name is kept as it is)
    const supplierId = {}; for (const s of SUPPLIERS) supplierId[s] = await idByName(c, 'proveedor', 'id_proveedor', s);
    const typeId = {}; for (const t of TYPES) typeId[t] = await idByName(c, 'tipo_producto', 'id_tipo', t);
    const popularity = {};
    for (const [code, name, type, supplier, cost, price, weight] of PRODUCTS) {
      const existing = await c.query('SELECT id_producto AS product_id FROM producto WHERE codigo = $1 OR lower(nombre) = lower($2)', [code, name]);
      const id = existing.rowCount ? existing.rows[0].product_id : (await c.query(`
        INSERT INTO producto (id_tipo, id_proveedor, codigo, nombre, valor_compra, valor_venta)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id_producto AS product_id`, [typeId[type], supplierId[supplier], code, name, cost, price])).rows[0].product_id;
      popularity[id] = weight;
    }
    const products = (await c.query('SELECT id_producto AS product_id, valor_compra AS purchase_price, valor_venta AS sale_price FROM producto')).rows
      .map((p) => ({ id: p.product_id, cost: Number(p.purchase_price), price: Number(p.sale_price), weight: popularity[p.product_id] || 3 }));

    // 4) Inventory: every product in every branch with stock between 30 and 150 units
    for (const b of branches) {
      for (const p of products) {
        await c.query(`INSERT INTO producto_sede (id_sede, id_producto, cantidad_disponible, estado_disponibilidad) VALUES ($1, $2, $3, TRUE)
                       ON CONFLICT (id_sede, id_producto) DO UPDATE SET cantidad_disponible = GREATEST(producto_sede.cantidad_disponible, EXCLUDED.cantidad_disponible)`,
          [b.branch_id, p.id, rnd(30, 150)]);
      }
    }
    // A couple of special cases to see in the screens: one product out of stock and one inactive
    const byCode = async (code) => (await c.query('SELECT id_producto AS product_id FROM producto WHERE codigo = $1', [code])).rows[0]?.product_id;
    const last = branches[branches.length - 1];
    if (last) await c.query('UPDATE producto_sede SET cantidad_disponible = 0 WHERE id_sede = $1 AND id_producto = $2', [last.branch_id, await byCode('BSA-004')]);
    if (branches[1]) await c.query('UPDATE producto_sede SET estado_disponibilidad = FALSE WHERE id_sede = $1 AND id_producto = $2', [branches[1].branch_id, await byCode('LIC-002')]);

    // 5) Sales history: closed orders with payment, invoice and invoice lines
    const usedCodes = new Set((await c.query('SELECT codigo_unico AS unique_code FROM pedido')).rows.map((r) => r.unique_code));
    const newCode = (d) => {
      let code;
      do code = `ORD-${ymd(d)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; while (usedCodes.has(code));
      usedCodes.add(code);
      return code;
    };
    const tablesOf = {}, cashiersOf = {};
    for (const b of branches) {
      tablesOf[b.branch_id] = (await c.query(`SELECT id_mesa AS table_id FROM mesa WHERE id_sede = $1 AND estado <> 'inactive' ORDER BY numero`, [b.branch_id])).rows.map((r) => r.table_id);
      const cs = (await c.query(`SELECT id_usuario AS user_id FROM usuario WHERE id_sede = $1 AND rol = 'Cashier' AND activo`, [b.branch_id])).rows.map((r) => r.user_id);
      cashiersOf[b.branch_id] = cs.length ? cs : [admin.user_id];
    }
    const pickLines = () => {
      const lines = new Map();
      for (let i = rnd(1, 5); i > 0; i--) {
        const p = pickWeighted(products);
        lines.set(p.id, { p, qty: (lines.get(p.id)?.qty || 0) + rnd(1, p.weight >= 6 ? 6 : 3) });
      }
      return [...lines.values()];
    };

    let closed = 0, deferredPending = 0;
    const now = new Date();
    for (let day = DAYS; day >= 0; day--) {
      for (const b of branches) {
        const date = new Date(now); date.setDate(now.getDate() - day);
        const weekend = [4, 5, 6].includes(date.getDay());          // Thursday to Saturday are busier
        const count = day === 0 ? rnd(2, 4) : (weekend ? rnd(10, 18) : rnd(4, 9));
        for (let k = 0; k < count; k++) {
          // Bar hours: from 5 pm to 1 am
          const created = new Date(date); created.setHours(17, 0, 0, 0);
          created.setMinutes(rnd(0, 8 * 60));
          if (created > now) created.setTime(now.getTime() - rnd(60, 240) * 60000);
          const closedAt = new Date(created.getTime() + rnd(25, 150) * 60000);
          if (closedAt > now) closedAt.setTime(now.getTime() - rnd(1, 20) * 60000);

          const lines = pickLines();
          const total = lines.reduce((s, l) => s + l.qty * l.p.price, 0);
          const tableId = tablesOf[b.branch_id][rnd(0, tablesOf[b.branch_id].length - 1)];
          const order = await c.query(`INSERT INTO pedido (id_mesa, codigo_unico, fecha_hora, fecha_cierre, estado)
                                       VALUES ($1, $2, $3, $4, 'closed') RETURNING id_pedido AS order_id`, [tableId, newCode(created), created, closedAt]);
          const orderId = order.rows[0].order_id;
          for (const l of lines) {
            await c.query('INSERT INTO detalle_pedido (id_pedido, id_producto, cantidad, valor_unitario, costo_unitario) VALUES ($1, $2, $3, $4, $5)',
              [orderId, l.p.id, l.qty, l.p.price, l.p.cost]);
          }

          // Payment method: mostly cash and cards; a few deferred (only the recent ones are still pending)
          const r = Math.random();
          let method = r < 0.45 ? 'cash' : r < 0.70 ? 'debit_card' : r < 0.96 ? 'credit_card' : 'deferred';
          let status = 'paid', received = total, change = 0, paidAt = closedAt;
          if (method === 'deferred') {
            if (day <= 3) { status = 'pending'; received = null; deferredPending++; }
            else { method = Math.random() < 0.5 ? 'cash' : 'debit_card'; paidAt = new Date(closedAt.getTime() + rnd(1, 3) * 86400000); }
          }
          if (method === 'cash') {
            const step = total > 100000 ? 50000 : 10000;            // the customer pays with round bills
            received = Math.random() < 0.3 ? total : Math.ceil(total / step) * step + (Math.random() < 0.3 ? step : 0);
            change = received - total;
          }
          const cashier = cashiersOf[b.branch_id][rnd(0, cashiersOf[b.branch_id].length - 1)];
          const pay = await c.query(`INSERT INTO pago (id_pedido, id_cajero, valor_pagado, valor_recibido, metodo_pago, fecha_hora, cambio, estado)
                                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id_pago AS payment_id`,
            [orderId, cashier, total, received, method, paidAt, change, status]);
          const inv = await c.query('INSERT INTO factura (id_pedido, id_pago, fecha_emision) VALUES ($1, $2, $3) RETURNING id_factura AS invoice_id',
            [orderId, pay.rows[0].payment_id, closedAt]);
          await c.query('INSERT INTO detalle_factura (id_factura, id_producto, cantidad, valor_unitario) SELECT $1, id_producto AS product_id, cantidad AS quantity, valor_unitario AS unit_price FROM detalle_pedido WHERE id_pedido = $2',
            [inv.rows[0].invoice_id, orderId]);
          closed++;
        }
      }
    }

    // 6) Open orders right now: 2 per branch on available tables (their products are taken out of the inventory)
    let open = 0;
    for (const b of branches) {
      const free = (await c.query(`SELECT id_mesa AS table_id FROM mesa WHERE id_sede = $1 AND estado = 'available' ORDER BY numero DESC LIMIT 2`, [b.branch_id])).rows;
      for (const t of free) {
        const created = new Date(now.getTime() - rnd(5, 90) * 60000);
        const order = await c.query(`INSERT INTO pedido (id_mesa, codigo_unico, fecha_hora, estado) VALUES ($1, $2, $3, 'open') RETURNING id_pedido AS order_id`,
          [t.table_id, newCode(created), created]);
        for (const l of pickLines()) {
          const stock = await c.query('UPDATE producto_sede SET cantidad_disponible = cantidad_disponible - $3 WHERE id_sede = $1 AND id_producto = $2 AND estado_disponibilidad AND cantidad_disponible >= $3 RETURNING 1',
            [b.branch_id, l.p.id, l.qty]);
          if (!stock.rowCount) continue;
          await c.query('INSERT INTO detalle_pedido (id_pedido, id_producto, cantidad, valor_unitario, costo_unitario) VALUES ($1, $2, $3, $4, $5)',
            [order.rows[0].order_id, l.p.id, l.qty, l.p.price, l.p.cost]);
        }
        await c.query(`UPDATE mesa SET estado = 'occupied' WHERE id_mesa = $1`, [t.table_id]);
        open++;
      }
    }

    await c.query(`INSERT INTO log_trazabilidad (id_usuario, categoria, operacion) VALUES ($1, 'system', $2)`,
      [admin.user_id, `${MARKER}: ${products.length} products, ${closed} closed orders (${DAYS} days), ${open} open orders`]);
    await c.query('COMMIT');
    console.log(`✔ ${MARKER}`);
    console.log(`  ${branches.length} branches × ${TABLES_PER_BRANCH} tables, ${products.length} products, ${STAFF.length} extra staff`);
    console.log(`  ${closed} closed orders with invoice (${deferredPending} deferred payments pending), ${open} open orders`);
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('✖ Error:', err.message);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
})();
