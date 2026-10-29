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
    const r = await db.query('SELECT id_factura AS invoice_id, id_pedido AS order_id, fecha_emision AS issued_at FROM factura WHERE id_factura = $1', [invoiceId]);
    if (!r.rowCount) return null;
    const inv = r.rows[0];
    const order = await loadOrder(db, inv.order_id);
    // Lines come from invoice_detail (what was billed), not from the live order
    const lines = (await db.query(`
      SELECT d.id_producto AS "productId", p.codigo AS code, p.nombre AS name, d.cantidad AS quantity,
             d.valor_unitario::float AS price, (d.cantidad * d.valor_unitario)::float AS subtotal
        FROM detalle_factura d JOIN producto p ON p.id_producto = d.id_producto
       WHERE d.id_factura = $1 ORDER BY p.nombre`, [invoiceId])).rows;
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
      SELECT i.id_factura AS id, i.fecha_emision AS "issuedAt", o.id_pedido AS "orderId", o.codigo_unico AS "orderCode",
             t.numero AS "table", b.nombre AS branch, pa.metodo_pago AS method, pa.valor_pagado::float AS total
        FROM factura i
        JOIN pedido o ON o.id_pedido = i.id_pedido
        JOIN mesa t ON t.id_mesa = o.id_mesa
        JOIN sede b ON b.id_sede = t.id_sede
        JOIN pago pa ON pa.id_pago = i.id_pago
       WHERE ($1::int IS NULL OR t.id_sede = $1)
         AND ($2::date IS NULL OR i.fecha_emision >= $2::date)
         AND ($3::date IS NULL OR i.fecha_emision < $3::date + 1)
       ORDER BY i.fecha_emision DESC, i.id_factura DESC
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
        SELECT o.id_pedido AS order_id, o.codigo_unico AS unique_code, o.estado AS status, t.id_sede AS branch_id, pa.id_pago AS payment_id, i.id_factura AS invoice_id
          FROM pedido o
          JOIN mesa t ON t.id_mesa = o.id_mesa
          LEFT JOIN pago pa ON pa.id_pedido = o.id_pedido
          LEFT JOIN factura i ON i.id_pedido = o.id_pedido
         WHERE o.id_pedido = $1 FOR UPDATE OF o`, [orderId]);
      if (!o.rowCount) throw new HttpError(404, 'The order does not exist.');
      const order = o.rows[0];
      if (!canAccessBranch(req.user, order.branch_id)) throw new HttpError(403, 'That order belongs to another branch.');
      if (order.status !== 'closed' || !order.payment_id) {
        throw new HttpError(409, 'Only paid (closed) orders can be invoiced.');
      }
      if (order.invoice_id) return { id: order.invoice_id, created: false, code: order.unique_code };
      const r = await c.query('INSERT INTO factura (id_pedido, id_pago) VALUES ($1, $2) RETURNING id_factura AS invoice_id', [orderId, order.payment_id]);
      await c.query('INSERT INTO detalle_factura (id_factura, id_producto, cantidad, valor_unitario) SELECT $1, id_producto AS product_id, cantidad AS quantity, valor_unitario AS unit_price FROM detalle_pedido WHERE id_pedido = $2', [r.rows[0].invoice_id, orderId]);
      return { id: r.rows[0].invoice_id, created: true, code: order.unique_code };
    });

    if (out.created) await log(req.user.id, 'invoices', `Generated invoice ${invoiceNumber(out.id)} for order ${out.code}`);
    res.status(out.created ? 201 : 200).json({ id: out.id, number: invoiceNumber(out.id), created: out.created });
  }));
};
