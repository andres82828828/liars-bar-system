// =====================================================================
//  Orders: create (table -> occupied), add / remove products while open, detail, list,
//  payment (closes the order, releases the table and generates the invoice)
//  Waiter work (create orders, add products): Administrator, Cashier and Waiter (the last two only in their branch)
//  Remove products and cancel orders (RF-48): Administrator and Cashier only
//  Cashier work (payments, deferred payments): Administrator and Cashier
// =====================================================================
const crypto = require('crypto');

module.exports = ({ app, pool, auth, allow, log, wrap, tx, HttpError, branchOf, canAccessBranch, money, ROLES }) => {

  const STATUSES = ['open', 'closed', 'cancelled'];
  // Methods that collect the money right away. 'deferred' closes the order now and the
  // payment stays PENDING until it is collected later with one of these methods.
  const PAYMENT_METHODS = { cash: 'Cash', credit_card: 'Credit card', debit_card: 'Debit card' };
  const ALL_METHODS = { ...PAYMENT_METHODS, deferred: 'Deferred payment' };
  const MAX_AMOUNT = 99999999;

  // Reads the amount received for an immediate payment and checks it against the total (in cents).
  //   cash → amount >= total; the change is computed (HU-024) · card → exactly the total
  function checkAmount(method, amountReceived, totalC) {
    const received = Number(amountReceived);
    if (amountReceived === '' || amountReceived == null || typeof amountReceived === 'boolean' || !Number.isFinite(received) || received <= 0) {
      throw new HttpError(400, 'Enter the amount received (a number greater than 0).');
    }
    if (received > MAX_AMOUNT) throw new HttpError(400, `The amount received cannot exceed ${money(MAX_AMOUNT)}.`);
    const receivedC = toCents(received);
    if (method === 'cash') {
      if (receivedC < totalC) {
        throw new HttpError(400, `Insufficient amount: the total is ${money(totalC / 100)} and ${money((totalC - receivedC) / 100)} is missing.`);
      }
    } else if (receivedC !== totalC) {
      throw new HttpError(400, `With a card the amount must be exactly the order total (${money(totalC / 100)}).`);
    }
    return { receivedC, changeC: receivedC - totalC };
  }

  // Money is compared in cents (integers) to avoid rounding errors
  const toCents = (n) => Math.round(Number(n) * 100);
  const invoiceNumber = (id) => 'INV-' + String(id).padStart(6, '0');

  // Readable unique code: ORD-20260929-A1B2C3
  function newOrderCode() {
    const d = new Date();
    const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `ORD-${date}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  }

  // Loads an order with its table, branch, products, subtotals, total, payment and invoice
  async function loadOrder(db, id) {
    const o = await db.query(`
      SELECT o.id_pedido AS id, o.codigo_unico AS code, o.fecha_hora AS "createdAt", o.fecha_cierre AS "closedAt", o.estado AS status,
             t.id_mesa AS "tableId", t.numero AS "table", b.id_sede AS "branchId", b.nombre AS branch, b.direccion AS "branchAddress"
        FROM pedido o
        JOIN mesa t ON t.id_mesa = o.id_mesa
        JOIN sede b ON b.id_sede = t.id_sede
       WHERE o.id_pedido = $1`, [id]);
    if (!o.rowCount) return null;

    const items = await db.query(`
      SELECT d.id_producto AS "productId", p.codigo AS code, p.nombre AS name, d.cantidad AS quantity,
             d.valor_unitario::float AS price, (d.cantidad * d.valor_unitario)::float AS subtotal
        FROM detalle_pedido d JOIN producto p ON p.id_producto = d.id_producto
       WHERE d.id_pedido = $1 ORDER BY p.nombre`, [id]);

    const pay = await db.query(`
      SELECT pa.id_pago AS id, pa.metodo_pago AS method, pa.estado AS status, pa.valor_pagado::float AS "amountPaid", pa.valor_recibido::float AS "amountReceived",
             pa.cambio::float AS change, pa.fecha_hora AS "paidAt", u.nombre_completo AS cashier,
             i.id_factura AS "invoiceId", i.fecha_emision AS "issuedAt"
        FROM pago pa
        LEFT JOIN usuario u ON u.id_usuario = pa.id_cajero
        LEFT JOIN factura i ON i.id_pago = pa.id_pago
       WHERE pa.id_pedido = $1`, [id]);

    const order = o.rows[0];
    order.items = items.rows;
    order.units = items.rows.reduce((acc, i) => acc + i.quantity, 0);
    order.total = items.rows.reduce((acc, i) => acc + toCents(i.subtotal), 0) / 100;
    const p = pay.rows[0];
    order.payment = p ? { id: p.id, method: p.method, status: p.status, amountPaid: p.amountPaid, amountReceived: p.amountReceived,
                          change: p.change, paidAt: p.paidAt, cashier: p.cashier } : null;
    order.invoice = p && p.invoiceId ? { id: p.invoiceId, number: invoiceNumber(p.invoiceId), issuedAt: p.issuedAt } : null;
    return order;
  }

  // Locks the order (two people cannot change it at the same time), checks access and that it is OPEN.
  // A closed or cancelled order cannot be modified any more.
  async function lockOpenOrder(c, user, id) {
    const r = await c.query(`
      SELECT o.id_pedido AS order_id, o.id_mesa AS table_id, o.estado AS status, o.codigo_unico AS unique_code, t.id_sede AS branch_id, t.numero AS table_number
        FROM pedido o JOIN mesa t ON t.id_mesa = o.id_mesa
       WHERE o.id_pedido = $1 FOR UPDATE OF o`, [id]);
    if (!r.rowCount) throw new HttpError(404, 'The order does not exist.');
    const order = r.rows[0];
    if (!canAccessBranch(user, order.branch_id)) throw new HttpError(403, 'That order belongs to another branch.');
    if (order.status !== 'open') throw new HttpError(409, `The order is ${order.status} and can no longer be modified.`);
    return order;
  }

  // ---------------------- List orders ----------------------
  // Filtered by the user's branch (the Administrator chooses one, or "all") and optionally by status.
  // With status=open it is the list of orders pending payment used by the Cash desk (HU-021).
  app.get('/api/orders', auth, wrap(async (req, res) => {
    const all = req.user.role === ROLES.ADMIN && req.query.branch_id === 'all';
    const branchId = all ? null : branchOf(req.user, req.query.branch_id);
    if (!all && !branchId) return res.json([]);
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;

    const { rows } = await pool.query(`
      SELECT o.id_pedido AS id, o.codigo_unico AS code, o.fecha_hora AS "createdAt", o.estado AS status,
             t.numero AS "table", b.nombre AS branch,
             COALESCE(SUM(d.cantidad), 0)::int AS units,
             COALESCE(SUM(d.cantidad * d.valor_unitario), 0)::float AS total
        FROM pedido o
        JOIN mesa t ON t.id_mesa = o.id_mesa
        JOIN sede b ON b.id_sede = t.id_sede
        LEFT JOIN detalle_pedido d ON d.id_pedido = o.id_pedido
       WHERE ($1::int IS NULL OR t.id_sede = $1) AND ($2::text IS NULL OR o.estado = $2)
       GROUP BY o.id_pedido, t.numero, b.nombre
       ORDER BY o.fecha_hora DESC, o.id_pedido DESC
       LIMIT 300`, [branchId, status]);
    res.json(rows);
  }));

  // ---------------------- Order detail ----------------------
  app.get('/api/orders/:id', auth, wrap(async (req, res) => {
    const order = await loadOrder(pool, Number(req.params.id));
    if (!order) throw new HttpError(404, 'The order does not exist.');
    if (!canAccessBranch(req.user, order.branchId)) throw new HttpError(403, 'That order belongs to another branch.');
    res.json(order);
  }));

  // ---------------------- Create an order on a table ----------------------
  app.post('/api/orders', auth, allow(ROLES.CASHIER, ROLES.WAITER), wrap(async (req, res) => {
    const tableId = Number((req.body || {}).tableId);
    if (!Number.isInteger(tableId) || tableId < 1) throw new HttpError(400, 'Select a table.');

    let created = null;
    for (let attempt = 0; attempt < 3 && !created; attempt++) {
      try {
        created = await tx(async (c) => {
          // FOR UPDATE: if two waiters pick the same table, only one wins
          const t = await c.query(`SELECT t.id_mesa AS table_id, t.id_sede AS branch_id, t.numero AS number, t.estado AS status, b.activo AS branch_active
                                     FROM mesa t JOIN sede b ON b.id_sede = t.id_sede
                                    WHERE t.id_mesa = $1 FOR UPDATE OF t`, [tableId]);
          if (!t.rowCount) throw new HttpError(404, 'The table does not exist.');
          const table = t.rows[0];
          if (!canAccessBranch(req.user, table.branch_id)) throw new HttpError(403, 'That table belongs to another branch.');
          if (!table.branch_active) throw new HttpError(409, 'The branch is inactive: it cannot receive orders.');
          if (table.status === 'inactive') throw new HttpError(409, `Table #${table.number} is inactive.`);
          if (table.status !== 'available') throw new HttpError(409, `Table #${table.number} is already occupied.`);

          const code = newOrderCode();
          const r = await c.query(
            `INSERT INTO pedido (id_mesa, codigo_unico, estado) VALUES ($1, $2, 'open') RETURNING id_pedido AS order_id`, [tableId, code]);
          await c.query(`UPDATE mesa SET estado = 'occupied' WHERE id_mesa = $1`, [tableId]);
          return { id: r.rows[0].order_id, code, table: table.number };
        });
      } catch (e) {
        // Repeated code (almost impossible): retry with another code
        if (!(e.code === '23505' && /codigo_unico/.test(e.constraint || ''))) throw e;
      }
    }
    if (!created) throw new HttpError(500, 'Could not generate a unique code. Please try again.');

    await log(req.user.id, 'orders', `Created order ${created.code} on table #${created.table}`);
    res.status(201).json(created);
  }));

  // ---------------------- Add a product to the order ----------------------
  app.post('/api/orders/:id/items', auth, allow(ROLES.CASHIER, ROLES.WAITER), wrap(async (req, res) => {
    const id = Number(req.params.id);
    const productId = Number((req.body || {}).productId);
    const quantity = (req.body || {}).quantity;
    if (!Number.isInteger(productId) || productId < 1) throw new HttpError(400, 'Select a product.');
    if (!Number.isInteger(quantity) || quantity < 1) throw new HttpError(400, 'The quantity must be a whole number greater than 0.');

    const result = await tx(async (c) => {
      const order = await lockOpenOrder(c, req.user, id);

      const inv = await c.query(`
        SELECT pb.cantidad_disponible AS quantity, pb.estado_disponibilidad AS is_active, p.valor_venta AS sale_price, p.valor_compra AS purchase_price, p.nombre AS name
          FROM producto_sede pb JOIN producto p ON p.id_producto = pb.id_producto
         WHERE pb.id_sede = $1 AND pb.id_producto = $2 FOR UPDATE OF pb`, [order.branch_id, productId]);

      // Check availability in the order's branch (HU-020)
      if (!inv.rowCount) throw new HttpError(409, 'That product is not offered in this branch.');
      const p = inv.rows[0];
      if (!p.is_active) throw new HttpError(409, `"${p.name}" is inactive in this branch and cannot be ordered.`);
      if (p.quantity < 1) throw new HttpError(409, `"${p.name}" is out of stock in this branch.`);
      if (quantity > p.quantity) throw new HttpError(409, `Not enough stock: only ${p.quantity} units of "${p.name}" left.`);

      // If the product was already in the order, the quantity is added (keeps the price it was added with)
      await c.query(`
        INSERT INTO detalle_pedido (id_pedido, id_producto, cantidad, valor_unitario, costo_unitario)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id_pedido, id_producto) DO UPDATE SET cantidad = detalle_pedido.cantidad + EXCLUDED.cantidad`,
        [id, productId, quantity, p.sale_price, p.purchase_price]);

      // Takes the units out of the inventory. At 0 the product is "out of stock" (leaves the catalog)
      // but stays ACTIVE: after a new stock entry it is sold again without reactivating it.
      await c.query('UPDATE producto_sede SET cantidad_disponible = cantidad_disponible - $3 WHERE id_sede = $1 AND id_producto = $2',
        [order.branch_id, productId, quantity]);

      return { order: await loadOrder(c, id), name: p.name };
    });

    await log(req.user.id, 'orders', `Added ${quantity} x "${result.name}" to order ${result.order.code}`);
    res.status(201).json(result.order);
  }));

  // ---------------------- Remove a product from an OPEN order ----------------------
  // RF-48: Administrator and Cashier (the Cashier only in their branch). Removes `quantity` units
  // (default: the whole line) and returns them to the branch inventory. Closed orders cannot change.
  app.delete('/api/orders/:id/items/:productId', auth, allow(ROLES.CASHIER), wrap(async (req, res) => {
    const id = Number(req.params.id);
    const productId = Number(req.params.productId);
    const body = req.body || {};
    if (!Number.isInteger(productId) || productId < 1) throw new HttpError(400, 'Select a product.');
    if (body.quantity !== undefined && (!Number.isInteger(body.quantity) || body.quantity < 1)) {
      throw new HttpError(400, 'The quantity to remove must be a whole number greater than 0.');
    }

    const result = await tx(async (c) => {
      const order = await lockOpenOrder(c, req.user, id);
      const line = await c.query(`
        SELECT d.cantidad AS quantity, p.nombre AS name FROM detalle_pedido d JOIN producto p ON p.id_producto = d.id_producto
         WHERE d.id_pedido = $1 AND d.id_producto = $2 FOR UPDATE OF d`, [id, productId]);
      if (!line.rowCount) throw new HttpError(404, 'That product is not in the order.');
      const { quantity: inOrder, name } = line.rows[0];
      const remove = body.quantity === undefined ? inOrder : body.quantity;
      if (remove > inOrder) throw new HttpError(400, `The order only has ${inOrder} unit(s) of "${name}".`);

      if (remove === inOrder) await c.query('DELETE FROM detalle_pedido WHERE id_pedido = $1 AND id_producto = $2', [id, productId]);
      else await c.query('UPDATE detalle_pedido SET cantidad = cantidad - $3 WHERE id_pedido = $1 AND id_producto = $2', [id, productId, remove]);

      // The units go back to the branch inventory
      await c.query('UPDATE producto_sede SET cantidad_disponible = cantidad_disponible + $3 WHERE id_sede = $1 AND id_producto = $2',
        [order.branch_id, productId, remove]);

      return { order: await loadOrder(c, id), name, remove };
    });

    await log(req.user.id, 'orders', `Removed ${result.remove} x "${result.name}" from order ${result.order.code} (returned to inventory)`);
    res.json(result.order);
  }));

  // ---------------------- Cancel an EMPTY order (releases the table) ----------------------
  // RF-48: Administrator and Cashier only. Only an order without products can be cancelled,
  // e.g. one opened on the wrong table.
  // To cancel an order with products, remove them first (they go back to the inventory).
  app.post('/api/orders/:id/cancel', auth, allow(ROLES.CASHIER), wrap(async (req, res) => {
    const id = Number(req.params.id);
    const code = await tx(async (c) => {
      const order = await lockOpenOrder(c, req.user, id);
      const n = await c.query('SELECT COUNT(*)::int AS n FROM detalle_pedido WHERE id_pedido = $1', [id]);
      if (n.rows[0].n > 0) throw new HttpError(409, 'It cannot be cancelled: the order has products. Remove them first (they go back to the inventory).');
      await c.query(`UPDATE pedido SET estado = 'cancelled', fecha_cierre = NOW() WHERE id_pedido = $1`, [id]);
      await c.query(`UPDATE mesa SET estado = 'available' WHERE id_mesa = $1`, [order.table_id]);
      return order.unique_code;
    });
    await log(req.user.id, 'orders', `Cancelled empty order ${code}`);
    res.json({ ok: true });
  }));

  // ---------------------- Register payment, close order and generate invoice ----------------------
  // Cashier (their branch) and Administrator. The total is recomputed on the server from
  // order_detail (the value sent by the browser is not trusted).
  //   cash                    → amount received >= total; the change is computed (HU-024)
  //   credit / debit card     → amount must be exactly the total (no change)
  //   deferred                → no money now: the payment stays 'pending' until it is collected
  // In ONE transaction (all or nothing), only if the payment is valid:
  //   1) payment saved  2) order -> 'closed' (no further changes)  3) table -> 'available'  4) invoice generated
  app.post('/api/orders/:id/payment', auth, allow(ROLES.CASHIER), wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { method, amountReceived } = req.body || {};
    if (!ALL_METHODS[method]) throw new HttpError(400, 'Select a valid payment method: cash, credit card, debit card or deferred payment.');
    const deferred = method === 'deferred';

    const result = await tx(async (c) => {
      const order = await lockOpenOrder(c, req.user, id);

      const t = await c.query('SELECT COALESCE(SUM(cantidad * valor_unitario), 0) AS total FROM detalle_pedido WHERE id_pedido = $1', [id]);
      const totalC = toCents(t.rows[0].total);
      if (totalC <= 0) throw new HttpError(409, 'The order has no products: there is nothing to charge.');

      const { receivedC, changeC } = deferred ? { receivedC: null, changeC: 0 } : checkAmount(method, amountReceived, totalC);

      const pay = await c.query(`
        INSERT INTO pago (id_pedido, id_cajero, valor_pagado, valor_recibido, metodo_pago, cambio, estado)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id_pago AS payment_id`,
        [id, req.user.id, totalC / 100, receivedC === null ? null : receivedC / 100, method, changeC / 100, deferred ? 'pending' : 'paid']);
      const paymentId = pay.rows[0].payment_id;

      await c.query(`UPDATE pedido SET estado = 'closed', fecha_cierre = NOW() WHERE id_pedido = $1`, [id]);
      await c.query(`UPDATE mesa SET estado = 'available' WHERE id_mesa = $1`, [order.table_id]);
      const inv = await c.query('INSERT INTO factura (id_pedido, id_pago) VALUES ($1, $2) RETURNING id_factura AS invoice_id', [id, paymentId]);
      // Invoice lines (invoice_detail): copy of the order lines at the moment of invoicing
      await c.query('INSERT INTO detalle_factura (id_factura, id_producto, cantidad, valor_unitario) SELECT $1, id_producto AS product_id, cantidad AS quantity, valor_unitario AS unit_price FROM detalle_pedido WHERE id_pedido = $2', [inv.rows[0].invoice_id, id]);

      return {
        paymentId, invoiceId: inv.rows[0].invoice_id, invoiceNumber: invoiceNumber(inv.rows[0].invoice_id),
        code: order.unique_code, table: order.table_number,
        method, status: deferred ? 'pending' : 'paid',
        total: totalC / 100, received: receivedC === null ? null : receivedC / 100, change: changeC / 100
      };
    });

    await log(req.user.id, 'payments', deferred
      ? `Registered DEFERRED payment of order ${result.code}: ${money(result.total)} pending. Order closed and table #${result.table} released`
      : `Registered payment of order ${result.code}: ${money(result.total)} by ${PAYMENT_METHODS[method]}` +
        (result.change ? ` (received ${money(result.received)}, change ${money(result.change)})` : '') +
        `. Order closed and table #${result.table} released`);
    await log(req.user.id, 'invoices', `Generated invoice ${result.invoiceNumber} for order ${result.code}`);
    res.status(201).json(result);
  }));

  // ---------------------- Deferred payments ----------------------
  // Pending deferred payments of the branch (the Administrator can ask for all branches)
  app.get('/api/payments/pending', auth, allow(ROLES.CASHIER), wrap(async (req, res) => {
    const all = req.user.role === ROLES.ADMIN && req.query.branch_id === 'all';
    const branchId = all ? null : branchOf(req.user, req.query.branch_id);
    if (!all && !branchId) return res.json([]);
    const { rows } = await pool.query(`
      SELECT pa.id_pago AS id, pa.valor_pagado::float AS total, pa.fecha_hora AS "deferredAt",
             o.id_pedido AS "orderId", o.codigo_unico AS "orderCode", t.numero AS "table", b.nombre AS branch, i.id_factura AS "invoiceId"
        FROM pago pa
        JOIN pedido o ON o.id_pedido = pa.id_pedido
        JOIN mesa t ON t.id_mesa = o.id_mesa
        JOIN sede b ON b.id_sede = t.id_sede
        LEFT JOIN factura i ON i.id_pago = pa.id_pago
       WHERE pa.estado = 'pending' AND ($1::int IS NULL OR t.id_sede = $1)
       ORDER BY pa.fecha_hora`, [branchId]);
    res.json(rows.map((x) => ({ ...x, invoiceNumber: x.invoiceId ? invoiceNumber(x.invoiceId) : null })));
  }));

  // Collects a deferred payment with cash or card. The payment becomes 'paid' (paid_at = now).
  app.post('/api/payments/:id/collect', auth, allow(ROLES.CASHIER), wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { method, amountReceived } = req.body || {};
    if (!PAYMENT_METHODS[method]) throw new HttpError(400, 'Select how the deferred payment is collected: cash, credit card or debit card.');

    const result = await tx(async (c) => {
      const r = await c.query(`
        SELECT pa.id_pago AS payment_id, pa.valor_pagado AS amount_paid, pa.estado AS status, o.codigo_unico AS unique_code, t.id_sede AS branch_id
          FROM pago pa JOIN pedido o ON o.id_pedido = pa.id_pedido JOIN mesa t ON t.id_mesa = o.id_mesa
         WHERE pa.id_pago = $1 FOR UPDATE OF pa`, [id]);
      if (!r.rowCount) throw new HttpError(404, 'The payment does not exist.');
      const p = r.rows[0];
      if (!canAccessBranch(req.user, p.branch_id)) throw new HttpError(403, 'That payment belongs to another branch.');
      if (p.status !== 'pending') throw new HttpError(409, 'This payment was already collected.');
      const totalC = toCents(p.amount_paid);
      const { receivedC, changeC } = checkAmount(method, amountReceived, totalC);
      await c.query(`UPDATE pago SET metodo_pago = $1, valor_recibido = $2, cambio = $3, estado = 'paid',
                            fecha_hora = NOW(), id_cajero = $4 WHERE id_pago = $5`,
        [method, receivedC / 100, changeC / 100, req.user.id, id]);
      return { code: p.unique_code, total: totalC / 100, received: receivedC / 100, change: changeC / 100 };
    });

    await log(req.user.id, 'payments', `Collected deferred payment of order ${result.code}: ${money(result.total)} by ${PAYMENT_METHODS[method]}` +
      (result.change ? ` (received ${money(result.received)}, change ${money(result.change)})` : ''));
    res.json({ ok: true, method, ...result });
  }));

  // Shared with routes/invoices.js
  app.locals.loadOrder = loadOrder;
  app.locals.invoiceNumber = invoiceNumber;
};
