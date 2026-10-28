// =====================================================================
//  Invoices (Cashier of the branch and Administrator)
//  An invoice is generated automatically when an order is paid (routes/orders.js).
//  Orders paid before invoices existed can get theirs with POST /api/orders/:id/invoice.
// =====================================================================
const { parseDate } = require('../validators');

const BUSINESS = { name: "Liar's Bar", taxId: 'NIT 900.123.456-7', phone: '+57 601 555 0123' };

module.exports = ({ app, pool, auth, allow, log, wrap, tx, HttpError, branchOf, canAccessBranch, ROLES }) => {

  const { loadOrder, invoiceNumber } = app.locals;

  // Builds the full invoice: business, branch, order, products and quantities, total and payment
  async function buildInvoice(db, invoiceId) {
    const r = await db.query('SELECT invoice_id, order_id, issued_at FROM invoice WHERE invoice_id = $1', [invoiceId]);
    if (!r.rowCount) return null;
    const inv = r.rows[0];
    const order = await loadOrder(db, inv.order_id);
    // Lines come from invoice_detail (what was billed), not from the live order
    const lines = (await db.query(`
      SELECT d.product_id AS "productId", p.code, p.name, d.quantity,
             d.unit_price::float AS price, (d.quantity * d.unit_price)::float AS subtotal
        FROM invoice_detail d JOIN product p ON p.product_id = d.product_id
       WHERE d.invoice_id = $1 ORDER BY p.name`, [invoiceId])).rows;
    const items = lines;
    return {
      id: inv.invoice_id,
      number: invoiceNumber(inv.invoice_id),
      issuedAt: inv.issued_at,
      business: BUSINESS,
      branch: { id: order.branchId, name: order.branch, address: order.branchAddress },
      order: { id: order.id, code: order.code, table: order.table, createdAt: order.createdAt, closedAt: order.closedAt },
      items,
      units: items.reduce((a, i) => a + i.quantity, 0),
      total: items.reduce((a, i) => a + Math.round(i.subtotal * 100), 0) / 100,
      payment: order.payment
    };
  }

  // List of invoices (filter by date and branch)
  app.get('/api/invoices', auth, allow(ROLES.CASHIER), wrap(async (req, res) => {
    const all = req.user.role === ROLES.ADMIN && req.query.branch_id === 'all';
    const branchId = all ? null : branchOf(req.user, req.query.branch_id);
    if (!all && !branchId) return res.json([]);
    const from = parseDate(req.query.from, 'start');
    const to = parseDate(req.query.to, 'end');

    const { rows } = await pool.query(`
      SELECT i.invoice_id AS id, i.issued_at AS "issuedAt", o.order_id AS "orderId", o.unique_code AS "orderCode",
             t.number AS "table", b.name AS branch, pa.method, pa.amount_paid::float AS total
        FROM invoice i
        JOIN customer_order o ON o.order_id = i.order_id
        JOIN bar_table t ON t.table_id = o.table_id
        JOIN branch b ON b.branch_id = t.branch_id
        JOIN payment pa ON pa.payment_id = i.payment_id
       WHERE ($1::int IS NULL OR t.branch_id = $1)
         AND ($2::date IS NULL OR i.issued_at >= $2::date)
         AND ($3::date IS NULL OR i.issued_at < $3::date + 1)
       ORDER BY i.issued_at DESC, i.invoice_id DESC
       LIMIT 500`, [branchId, from, to]);
    res.json(rows.map((x) => ({ ...x, number: invoiceNumber(x.id) })));
  }));

  app.get('/api/invoices/:id', auth, allow(ROLES.CASHIER), wrap(async (req, res) => {
    const invoice = await buildInvoice(pool, Number(req.params.id));
    if (!invoice) throw new HttpError(404, 'The invoice does not exist.');
    if (!canAccessBranch(req.user, invoice.branch.id)) throw new HttpError(403, 'That invoice belongs to another branch.');
    res.json(invoice);
  }));

  // Generates the invoice of a closed (paid) order that does not have one yet. Idempotent.
  app.post('/api/orders/:id/invoice', auth, allow(ROLES.CASHIER), wrap(async (req, res) => {
    const orderId = Number(req.params.id);
    const out = await tx(async (c) => {
      const o = await c.query(`
        SELECT o.order_id, o.unique_code, o.status, t.branch_id, pa.payment_id, i.invoice_id
          FROM customer_order o
          JOIN bar_table t ON t.table_id = o.table_id
          LEFT JOIN payment pa ON pa.order_id = o.order_id
          LEFT JOIN invoice i ON i.order_id = o.order_id
         WHERE o.order_id = $1 FOR UPDATE OF o`, [orderId]);
      if (!o.rowCount) throw new HttpError(404, 'The order does not exist.');
      const order = o.rows[0];
      if (!canAccessBranch(req.user, order.branch_id)) throw new HttpError(403, 'That order belongs to another branch.');
      if (order.status !== 'closed' || !order.payment_id) {
        throw new HttpError(409, 'Only paid (closed) orders can be invoiced.');
      }
      if (order.invoice_id) return { id: order.invoice_id, created: false, code: order.unique_code };
      const r = await c.query('INSERT INTO invoice (order_id, payment_id) VALUES ($1, $2) RETURNING invoice_id', [orderId, order.payment_id]);
      await c.query('INSERT INTO invoice_detail (invoice_id, product_id, quantity, unit_price) SELECT $1, product_id, quantity, unit_price FROM order_detail WHERE order_id = $2', [r.rows[0].invoice_id, orderId]);
      return { id: r.rows[0].invoice_id, created: true, code: order.unique_code };
    });

    if (out.created) await log(req.user.id, 'invoices', `Generated invoice ${invoiceNumber(out.id)} for order ${out.code}`);
    res.status(out.created ? 201 : 200).json({ id: out.id, number: invoiceNumber(out.id), created: out.created });
  }));
};
