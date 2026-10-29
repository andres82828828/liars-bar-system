// =====================================================================
//  Product types, suppliers and products
//  Query: any signed-in user · Create / edit / delete: Administrator
// =====================================================================
module.exports = ({ app, pool, auth, adminOnly, log, wrap, HttpError }) => {

  const MAX_PRICE = 99999999;
  // Deleting a row that is still referenced: 23503 (NO ACTION) or 23001 (ON DELETE RESTRICT)
  const IN_USE = ['23503', '23001'];

  // Simple "name" catalogs (product types and suppliers) share the same CRUD logic
  function nameCatalog({ route, table, idCol, label, maxLen }) {
    const readName = (body) => {
      const name = String((body && body.name) ?? '').trim();
      if (!name) throw new HttpError(400, `The ${label} name is required.`);
      if (name.length > maxLen) throw new HttpError(400, `The ${label} name cannot be longer than ${maxLen} characters.`);
      return name;
    };
    const ensureFree = async (name, exceptId = 0) => {
      const dup = await pool.query(`SELECT 1 FROM ${table} WHERE LOWER(nombre) = LOWER($1) AND ${idCol} <> $2`, [name, exceptId]);
      if (dup.rowCount) throw new HttpError(409, `The ${label} "${name}" already exists.`);
    };

    app.get(`/api/${route}`, auth, wrap(async (req, res) => {
      const { rows } = await pool.query(`
        SELECT x.${idCol} AS id, x.nombre AS name, COUNT(p.id_producto)::int AS products
          FROM ${table} x LEFT JOIN producto p ON p.${idCol} = x.${idCol}
         GROUP BY x.${idCol} ORDER BY x.nombre`);
      res.json(rows);
    }));

    app.post(`/api/${route}`, auth, adminOnly, wrap(async (req, res) => {
      const name = readName(req.body);
      await ensureFree(name);
      const r = await pool.query(`INSERT INTO ${table} (nombre) VALUES ($1) RETURNING ${idCol}`, [name]);
      await log(req.user.id, 'catalog', `Created ${label} "${name}"`);
      res.status(201).json({ id: r.rows[0][idCol] });
    }));

    app.put(`/api/${route}/:id`, auth, adminOnly, wrap(async (req, res) => {
      const id = Number(req.params.id);
      const name = readName(req.body);
      await ensureFree(name, id);
      const r = await pool.query(`UPDATE ${table} SET nombre = $1 WHERE ${idCol} = $2`, [name, id]);
      if (!r.rowCount) throw new HttpError(404, `The ${label} was not found.`);
      await log(req.user.id, 'catalog', `Renamed ${label} ${id} to "${name}"`);
      res.json({ ok: true });
    }));

    app.delete(`/api/${route}/:id`, auth, adminOnly, wrap(async (req, res) => {
      const id = Number(req.params.id);
      try {
        const r = await pool.query(`DELETE FROM ${table} WHERE ${idCol} = $1 RETURNING nombre AS name`, [id]);
        if (!r.rowCount) throw new HttpError(404, `The ${label} was not found.`);
        await log(req.user.id, 'catalog', `Deleted ${label} "${r.rows[0].name}"`);
        res.json({ ok: true });
      } catch (e) {
        if (IN_USE.includes(e.code)) {
          // Explain WHY it cannot be deleted and what to do instead
          const x = (await pool.query(`SELECT x.nombre AS name, COUNT(p.id_producto)::int AS n FROM ${table} x
            LEFT JOIN producto p ON p.${idCol} = x.${idCol} WHERE x.${idCol} = $1 GROUP BY x.nombre`, [id])).rows[0] || { name: '', n: 0 };
          throw new HttpError(409, `The ${label} "${x.name}" cannot be deleted because ${x.n} product(s) still use it. ` +
            `First assign another ${label} to those products (Products → Edit) or delete them, then try again.`);
        }
        throw e;
      }
    }));
  }

  nameCatalog({ route: 'product-types', table: 'tipo_producto', idCol: 'id_tipo', label: 'product type', maxLen: 50 });
  nameCatalog({ route: 'suppliers', table: 'proveedor', idCol: 'id_proveedor', label: 'supplier', maxLen: 100 });

  // ----------------------------- PRODUCTS -----------------------------
  app.get('/api/products', auth, wrap(async (req, res) => {
    const { rows } = await pool.query(`
      SELECT p.id_producto AS id, p.codigo AS code, p.nombre AS name, p.id_tipo AS "typeId", t.nombre AS type,
             p.id_proveedor AS "supplierId", s.nombre AS supplier,
             p.valor_compra::float AS "purchasePrice", p.valor_venta::float AS "salePrice",
             -- branches where the product is currently ACTIVE (HU-020)
             COALESCE((SELECT string_agg(b.nombre, ', ' ORDER BY b.nombre)
                         FROM producto_sede pb JOIN sede b ON b.id_sede = pb.id_sede
                        WHERE pb.id_producto = p.id_producto AND pb.estado_disponibilidad), '') AS branches
        FROM producto p
        JOIN tipo_producto t ON t.id_tipo = p.id_tipo
        JOIN proveedor s ON s.id_proveedor = p.id_proveedor
       ORDER BY p.nombre`);
    res.json(rows);
  }));

  function validateProduct(b = {}) {
    const code = String(b.code ?? '').trim().toUpperCase();
    const name = String(b.name ?? '').trim();
    const typeId = Number(b.typeId);
    const supplierId = Number(b.supplierId);
    const purchasePrice = Number(b.purchasePrice);
    const salePrice = Number(b.salePrice);

    if (!code || !name) throw new HttpError(400, 'The code and the name are required.');
    if (code.length > 50) throw new HttpError(400, 'The code cannot be longer than 50 characters.');
    if (name.length > 100) throw new HttpError(400, 'The name cannot be longer than 100 characters.');
    if (!Number.isInteger(typeId) || typeId < 1) throw new HttpError(400, 'Select the product type.');
    if (!Number.isInteger(supplierId) || supplierId < 1) throw new HttpError(400, 'Select the supplier.');
    if (b.purchasePrice === '' || b.purchasePrice == null || b.salePrice === '' || b.salePrice == null) {
      throw new HttpError(400, 'Enter the purchase price and the sale price.');
    }
    if (!Number.isFinite(purchasePrice) || purchasePrice < 0 || purchasePrice > MAX_PRICE) {
      throw new HttpError(400, 'The purchase price must be a valid number (0 or more).');
    }
    if (!Number.isFinite(salePrice) || salePrice <= 0 || salePrice > MAX_PRICE) {
      throw new HttpError(400, 'The sale price must be a number greater than 0.');
    }
    // Business rule: never sell below cost
    if (salePrice < purchasePrice) throw new HttpError(400, 'The sale price cannot be lower than the purchase price.');
    return { code, name, typeId, supplierId, purchasePrice, salePrice };
  }

  function productError(e) {
    if (e.code === '23505') return new HttpError(409, 'A product with that code already exists.');
    if (e.code === '23503') return new HttpError(400, 'The selected type or supplier does not exist.');
    if (e.code === '23514') return new HttpError(400, 'The sale price cannot be lower than the purchase price.');
    return e;
  }

  app.post('/api/products', auth, adminOnly, wrap(async (req, res) => {
    const p = validateProduct(req.body);
    try {
      const r = await pool.query(
        `INSERT INTO producto (id_tipo, id_proveedor, codigo, nombre, valor_compra, valor_venta)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id_producto AS product_id`,
        [p.typeId, p.supplierId, p.code, p.name, p.purchasePrice, p.salePrice]);
      await log(req.user.id, 'catalog', `Created product ${p.code} - ${p.name}`);
      res.status(201).json({ id: r.rows[0].product_id });
    } catch (e) { throw productError(e); }
  }));

  app.put('/api/products/:id', auth, adminOnly, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const p = validateProduct(req.body);
    try {
      const r = await pool.query(
        `UPDATE producto SET id_tipo = $1, id_proveedor = $2, codigo = $3, nombre = $4, valor_compra = $5, valor_venta = $6
          WHERE id_producto = $7`,
        [p.typeId, p.supplierId, p.code, p.name, p.purchasePrice, p.salePrice, id]);
      if (!r.rowCount) throw new HttpError(404, 'Product not found.');
      await log(req.user.id, 'catalog', `Edited product ${p.code} - ${p.name}`);
      res.json({ ok: true });
    } catch (e) { throw productError(e); }
  }));

  app.delete('/api/products/:id', auth, adminOnly, wrap(async (req, res) => {
    const id = Number(req.params.id);
    try {
      const r = await pool.query('DELETE FROM producto WHERE id_producto = $1 RETURNING codigo AS code, nombre AS name', [id]);
      if (!r.rowCount) throw new HttpError(404, 'Product not found.');
      await log(req.user.id, 'catalog', `Deleted product ${r.rows[0].code} - ${r.rows[0].name}`);
      res.json({ ok: true });
    } catch (e) {
      if (IN_USE.includes(e.code)) {
        // Past orders keep a reference to the product: deleting it would alter old invoices and reports
        const x = (await pool.query(`SELECT p.nombre AS name, COUNT(DISTINCT d.id_pedido)::int AS n FROM producto p
          LEFT JOIN detalle_pedido d ON d.id_producto = p.id_producto WHERE p.id_producto = $1 GROUP BY p.nombre`, [id])).rows[0] || { name: '', n: 0 };
        throw new HttpError(409, `"${x.name}" cannot be deleted because it appears in ${x.n} order(s). ` +
          'Deleting it would change past invoices and sales reports. ' +
          'If you no longer want to sell it, deactivate it in each branch from Inventory.');
      }
      throw e;
    }
  }));
};
