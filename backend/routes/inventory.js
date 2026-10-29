// =====================================================================
//  Inventory per branch (product_branch) and available catalog
//  Query: everyone (Cashier / Waiter only their branch) · Stock entries: Administrator and Cashier
//  Activate / deactivate a product in a branch: Administrator (HU-020)
//
//  product_branch.is_active = the product is OFFERED in that branch.
//  It is an administrator decision and does NOT depend on stock: an active product with
//  0 units is "out of stock"; an inactive one is not sold even if it has units.
// =====================================================================
const { toId } = require('../validators');

module.exports = ({ app, pool, auth, allow, adminOnly, log, wrap, HttpError, branchOf, ROLES }) => {

  const MAX_ENTRY = 100000;      // max units per entry
  const MAX_STOCK = 1000000;     // max accumulated units per product and branch

  // Checks that the branch and the product exist and returns their names (for messages and the log)
  async function branchAndProduct(branchId, productId) {
    const r = await pool.query(`
      SELECT (SELECT nombre AS name FROM sede WHERE id_sede = $1)   AS branch,
             (SELECT nombre AS name FROM producto WHERE id_producto = $2) AS product`, [branchId, productId]);
    const { branch, product } = r.rows[0];
    if (!branch) throw new HttpError(404, 'The selected branch does not exist.');
    if (!product) throw new HttpError(404, 'The selected product does not exist.');
    return { branch, product };
  }

  // Products per branch: ALL products with their relation in the branch (HU-020)
  //   assigned = the product-branch relation exists · active = it is offered · quantity = stock
  app.get('/api/inventory', auth, wrap(async (req, res) => {
    const branchId = branchOf(req.user, req.query.branch_id);
    if (!branchId) return res.json([]);
    const { rows } = await pool.query(`
      SELECT p.id_producto AS id, p.codigo AS code, p.nombre AS name, t.nombre AS type,
             (pb.id_producto IS NOT NULL) AS assigned,
             COALESCE(pb.cantidad_disponible, 0) AS quantity,
             COALESCE(pb.estado_disponibilidad, FALSE) AS active
        FROM producto p
        JOIN tipo_producto t ON t.id_tipo = p.id_tipo
        LEFT JOIN producto_sede pb ON pb.id_producto = p.id_producto AND pb.id_sede = $1
       ORDER BY p.nombre`, [branchId]);
    res.json(rows);
  }));

  // Stock entry: ADDS units to what the branch already has.
  // Administrator (any branch) and Cashier (only theirs). The Waiter can only look.
  // If the relation did not exist it is created ACTIVE; otherwise its state is kept (does not reactivate).
  app.post('/api/inventory', auth, allow(ROLES.CASHIER), wrap(async (req, res) => {
    const body = req.body || {};
    const branchId = branchOf(req.user, body.branchId);     // the Cashier always uses their own branch
    const productId = toId(body.productId);
    const quantity = body.quantity;
    if (!branchId) throw new HttpError(400, 'No branch selected.');
    if (!productId) throw new HttpError(400, 'Select the product.');
    if (!Number.isInteger(quantity) || quantity < 1) throw new HttpError(400, 'The quantity must be a whole number greater than 0.');
    if (quantity > MAX_ENTRY) throw new HttpError(400, `The maximum quantity per entry is ${MAX_ENTRY}.`);

    const { branch, product } = await branchAndProduct(branchId, productId);
    const current = await pool.query(
      'SELECT cantidad_disponible AS quantity FROM producto_sede WHERE id_sede = $1 AND id_producto = $2', [branchId, productId]);
    const has = current.rowCount ? current.rows[0].quantity : 0;
    if (has + quantity > MAX_STOCK) {
      throw new HttpError(400, `A product cannot exceed ${MAX_STOCK} units per branch (there are ${has}).`);
    }

    try {
      const r = await pool.query(`
        INSERT INTO producto_sede (id_sede, id_producto, cantidad_disponible, estado_disponibilidad)
        VALUES ($1, $2, $3, TRUE)
        ON CONFLICT (id_sede, id_producto) DO UPDATE
           SET cantidad_disponible = producto_sede.cantidad_disponible + EXCLUDED.cantidad_disponible
        RETURNING cantidad_disponible AS quantity, estado_disponibilidad AS is_active`, [branchId, productId, quantity]);
      await log(req.user.id, 'inventory', `Stock entry: +${quantity} of "${product}" in branch "${branch}"`);
      res.status(201).json({ quantity: r.rows[0].quantity, active: r.rows[0].is_active });
    } catch (e) {
      if (e.code === '23503') throw new HttpError(400, 'The branch or the product does not exist.');
      if (e.code === '22003') throw new HttpError(400, 'The total quantity exceeds the allowed maximum.');
      throw e;
    }
  }));

  // Activate / deactivate a product in a branch (HU-020)
  // If the product was not related to the branch yet, the relation is created with 0 units.
  app.patch('/api/inventory/availability', auth, adminOnly, wrap(async (req, res) => {
    const body = req.body || {};
    const branchId = toId(body.branchId);
    const productId = toId(body.productId);
    const { active } = body;
    if (!branchId || !productId) throw new HttpError(400, 'Select the branch and the product.');
    if (typeof active !== 'boolean') throw new HttpError(400, 'Invalid "active" value.');

    const { branch, product } = await branchAndProduct(branchId, productId);
    const r = await pool.query(`
      INSERT INTO producto_sede (id_sede, id_producto, cantidad_disponible, estado_disponibilidad)
      VALUES ($1, $2, 0, $3)
      ON CONFLICT (id_sede, id_producto) DO UPDATE SET estado_disponibilidad = EXCLUDED.estado_disponibilidad
      RETURNING cantidad_disponible AS quantity`, [branchId, productId, active]);

    await log(req.user.id, 'inventory', `${active ? 'Activated' : 'Deactivated'} product "${product}" in branch "${branch}"`);
    res.json({ ok: true, active, quantity: r.rows[0].quantity });
  }));

  // Catalog available for sale: only ACTIVE products with stock in the branch
  app.get('/api/catalog', auth, wrap(async (req, res) => {
    const branchId = branchOf(req.user, req.query.branch_id);
    if (!branchId) return res.json([]);
    const { rows } = await pool.query(`
      SELECT p.id_producto AS id, p.codigo AS code, p.nombre AS name, t.nombre AS type,
             p.valor_venta::float AS price, pb.cantidad_disponible AS quantity
        FROM producto_sede pb
        JOIN producto p ON p.id_producto = pb.id_producto
        JOIN tipo_producto t ON t.id_tipo = p.id_tipo
       WHERE pb.id_sede = $1 AND pb.estado_disponibilidad = TRUE AND pb.cantidad_disponible > 0
       ORDER BY t.nombre, p.nombre`, [branchId]);
    res.json(rows);
  }));
};
