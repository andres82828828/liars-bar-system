// =====================================================================
//  Orders: create (table -> occupied), add products (they cannot be removed), detail, list,
//  payment (closes the order, releases the table and generates the invoice)
//  Waiter work: Administrator, Cashier and Waiter (the last two only in their branch)
//  Cashier work (payments): Administrator and Cashier
// =====================================================================
const crypto = require('crypto');

module.exports = ({ app, pool, auth, allow, log, wrap, tx, HttpError, branchOf, canAccessBranch, money, ROLES }) => {

  const STATUSES = ['open', 'closed', 'cancelled'];
  const PAYMENT_METHODS = { cash: 'Cash', credit_card: 'Credit card', debit_card: 'Debit card' };
  const MAX_AMOUNT = 99999999;

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
      SELECT o.order_id AS id, o.unique_code AS code, o.created_at AS "createdAt", o.closed_at AS "closedAt", o.status,
             t.table_id AS "tableId", t.number AS "table", b.branch_id AS "branchId", b.name AS branch, b.address AS "branchAddress"
        FROM customer_order o
        JOIN bar_table t ON t.table_id = o.table_id
        JOIN branch b ON b.branch_id = t.branch_id
       WHERE o.order_id = $1`, [id]);
    if (!o.rowCount) return null;

    const items = await db.query(`
      SELECT d.product_id AS "productId", p.code, p.name, d.quantity,
             d.unit_price::float AS price, (d.quantity * d.unit_price)::float AS subtotal
        FROM order_detail d JOIN product p ON p.product_id = d.product_id
       WHERE d.order_id = $1 ORDER BY p.name`, [id]);

    const pay = await db.query(`
      SELECT pa.payment_id AS id, pa.method, pa.amount_paid::float AS "amountPaid", pa.amount_received::float AS "amountReceived",
             pa.change_amount::float AS change, pa.paid_at AS "paidAt", u.full_name AS cashier,
             i.invoice_id AS "invoiceId", i.issued_at AS "issuedAt"
        FROM payment pa
        LEFT JOIN app_user u ON u.user_id = pa.cashier_id
        LEFT JOIN invoice i ON i.payment_id = pa.payment_id
       WHERE pa.order_id = $1`, [id]);

    const order = o.rows[0];
    order.items = items.rows;
    order.units = items.rows.reduce((acc, i) => acc + i.quantity, 0);
    order.total = items.rows.reduce((acc, i) => acc + toCents(i.subtotal), 0) / 100;
    const p = pay.rows[0];
    order.payment = p ? { id: p.id, method: p.method, amountPaid: p.amountPaid, amountReceived: p.amountReceived,
                          change: p.change, paidAt: p.paidAt, cashier: p.cashier } : null;
    order.invoice = p && p.invoiceId ? { id: p.invoiceId, number: invoiceNumber(p.invoiceId), issuedAt: p.issuedAt } : null;
    return order;
  }

  // Locks the order (two people cannot change it at the same time), checks access and that it is OPEN.
  // A closed or cancelled order cannot be modified any more.
  async function lockOpenOrder(c, user, id) {
    const r = await c.query(`
      SELECT o.order_id, o.table_id, o.status, o.unique_code, t.branch_id, t.number AS table_number
        FROM customer_order o JOIN bar_table t ON t.table_id = o.table_id
       WHERE o.order_id = $1 FOR UPDATE OF o`, [id]);
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
      SELECT o.order_id AS id, o.unique_code AS code, o.created_at AS "createdAt", o.status,
             t.number AS "table", b.name AS branch,
             COALESCE(SUM(d.quantity), 0)::int AS units,
             COALESCE(SUM(d.quantity * d.unit_price), 0)::float AS total
        FROM customer_order o
        JOIN bar_table t ON t.table_id = o.table_id
        JOIN branch b ON b.branch_id = t.branch_id
        LEFT JOIN order_detail d ON d.order_id = o.order_id
       WHERE ($1::int IS NULL OR t.branch_id = $1) AND ($2::text IS NULL OR o.status = $2)
       GROUP BY o.order_id, t.number, b.name
       ORDER BY o.created_at DESC, o.order_id DESC
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
          const t = await c.query('SELECT table_id, branch_id, number, status FROM bar_table WHERE table_id = $1 FOR UPDATE', [tableId]);
          if (!t.rowCount) throw new HttpError(404, 'The table does not exist.');
          const table = t.rows[0];
          if (!canAccessBranch(req.user, table.branch_id)) throw new HttpError(403, 'That table belongs to another branch.');
          if (table.status !== 'free') throw new HttpError(409, `Table #${table.number} is already occupied.`);

          const code = newOrderCode();
          const r = await c.query(
            `INSERT INTO customer_order (table_id, unique_code, status) VALUES ($1, $2, 'open') RETURNING order_id`, [tableId, code]);
          await c.query(`UPDATE bar_table SET status = 'occupied' WHERE table_id = $1`, [tableId]);
          return { id: r.rows[0].order_id, code, table: table.number };
        });
      } catch (e) {
        // Repeated code (almost impossible): retry with another code
        if (!(e.code === '23505' && /unique_code/.test(e.constraint || ''))) throw e;
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
        SELECT pb.quantity, pb.is_active, p.sale_price, p.purchase_price, p.name
          FROM product_branch pb JOIN product p ON p.product_id = pb.product_id
         WHERE pb.branch_id = $1 AND pb.product_id = $2 FOR UPDATE OF pb`, [order.branch_id, productId]);

      // Check availability in the order's branch (HU-020)
      if (!inv.rowCount) throw new HttpError(409, 'That product is not offered in this branch.');
      const p = inv.rows[0];
      if (!p.is_active) throw new HttpError(409, `"${p.name}" is inactive in this branch and cannot be ordered.`);
      if (p.quantity < 1) throw new HttpError(409, `"${p.name}" is out of stock in this branch.`);
      if (quantity > p.quantity) throw new HttpError(409, `Not enough stock: only ${p.quantity} units of "${p.name}" left.`);

      // If the product was already in the order, the quantity is added (keeps the price it was added with)
      await c.query(`
        INSERT INTO order_detail (order_id, product_id, quantity, unit_price, unit_cost)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (order_id, product_id) DO UPDATE SET quantity = order_detail.quantity + EXCLUDED.quantity`,
        [id, productId, quantity, p.sale_price, p.purchase_price]);

      // Takes the units out of the inventory. At 0 the product is "out of stock" (leaves the catalog)
      // but stays ACTIVE: after a new stock entry it is sold again without reactivating it.
      await c.query('UPDATE product_branch SET quantity = quantity - $3 WHERE branch_id = $1 AND product_id = $2',
        [order.branch_id, productId, quantity]);

      return { order: await loadOrder(c, id), name: p.name };
    });

    await log(req.user.id, 'orders', `Added ${quantity} x "${result.name}" to order ${result.order.code}`);
    res.status(201).json(result.order);
  }));

  // ---------------------- Cancel an EMPTY order (releases the table) ----------------------
  // Business rule: products added to an open order can NOT be removed (no role can).
  // So only an order without products can be cancelled, e.g. one opened on the wrong table.
  app.post('/api/orders/:id/cancel', auth, allow(ROLES.CASHIER, ROLES.WAITER), wrap(async (req, res) => {
    const id = Number(req.params.id);
    const code = await tx(async (c) => {
      const order = await lockOpenOrder(c, req.user, id);
      const n = await c.query('SELECT COUNT(*)::int AS n FROM order_detail WHERE order_id = $1', [id]);
      if (n.rows[0].n > 0) throw new HttpError(409, 'It cannot be cancelled: the order already has products and they cannot be removed.');
      await c.query(`UPDATE customer_order SET status = 'cancelled', closed_at = NOW() WHERE order_id = $1`, [id]);
      await c.query(`UPDATE bar_table SET status = 'free' WHERE table_id = $1`, [order.table_id]);
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
  // In ONE transaction (all or nothing), only if the payment is valid:
  //   1) payment saved  2) order -> 'closed' (no further changes)  3) table -> 'free'  4) invoice generated
  app.post('/api/orders/:id/payment', auth, allow(ROLES.CASHIER), wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { method, amountReceived } = req.body || {};
    if (!PAYMENT_METHODS[method]) throw new HttpError(400, 'Select a valid payment method: cash, credit card or debit card.');
    const received = Number(amountReceived);
    if (amountReceived === '' || amountReceived == null || typeof amountReceived === 'boolean' || !Number.isFinite(received) || received <= 0) {
      throw new HttpError(400, 'Enter the amount received (a number greater than 0).');
    }
    if (received > MAX_AMOUNT) throw new HttpError(400, `The amount received cannot exceed ${money(MAX_AMOUNT)}.`);

    const result = await tx(async (c) => {
      const order = await lockOpenOrder(c, req.user, id);

      const t = await c.query('SELECT COALESCE(SUM(quantity * unit_price), 0) AS total FROM order_detail WHERE order_id = $1', [id]);
      const totalC = toCents(t.rows[0].total);
      if (totalC <= 0) throw new HttpError(409, 'The order has no products: there is nothing to charge.');

      // Change for cash payments (HU-024): compare received with total and compute the difference
      const receivedC = toCents(received);
      if (method === 'cash') {
        if (receivedC < totalC) {
          throw new HttpError(400, `Insufficient amount: the total is ${money(totalC / 100)} and ${money((totalC - receivedC) / 100)} is missing.`);
        }
      } else if (receivedC !== totalC) {
        throw new HttpError(400, `With a card the amount must be exactly the order total (${money(totalC / 100)}).`);
      }
      const changeC = receivedC - totalC;

      const pay = await c.query(`
        INSERT INTO payment (order_id, cashier_id, amount_paid, amount_received, method, change_amount)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING payment_id`,
        [id, req.user.id, totalC / 100, receivedC / 100, method, changeC / 100]);
      const paymentId = pay.rows[0].payment_id;

      await c.query(`UPDATE customer_order SET status = 'closed', closed_at = NOW() WHERE order_id = $1`, [id]);
      await c.query(`UPDATE bar_table SET status = 'free' WHERE table_id = $1`, [order.table_id]);
      const inv = await c.query('INSERT INTO invoice (order_id, payment_id) VALUES ($1, $2) RETURNING invoice_id', [id, paymentId]);

      return {
        paymentId, invoiceId: inv.rows[0].invoice_id, invoiceNumber: invoiceNumber(inv.rows[0].invoice_id),
        code: order.unique_code, table: order.table_number,
        method, total: totalC / 100, received: receivedC / 100, change: changeC / 100
      };
    });

    await log(req.user.id, 'payments', `Registered payment of order ${result.code}: ${money(result.total)} by ${PAYMENT_METHODS[method]}` +
      (result.change ? ` (received ${money(result.received)}, change ${money(result.change)})` : '') +
      `. Order closed and table #${result.table} released`);
    await log(req.user.id, 'invoices', `Generated invoice ${result.invoiceNumber} for order ${result.code}`);
    res.status(201).json(result);
  }));

  // Shared with routes/invoices.js
  app.locals.loadOrder = loadOrder;
  app.locals.invoiceNumber = invoiceNumber;
};
