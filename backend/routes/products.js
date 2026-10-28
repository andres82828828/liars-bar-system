// =====================================================================
//  Product types, suppliers and products
//  Query: any signed-in user · Create / edit / delete: Administrator
// =====================================================================
module.exports = ({ app, pool, auth, adminOnly, log, wrap, HttpError }) => {

  const MAX_PRICE = 99999999;

  // Simple "name" catalogs (product types and suppliers) share the same CRUD logic
  function nameCatalog({ route, table, idCol, label, maxLen, inUseMsg }) {
    const readName = (body) => {
      const name = String((body && body.name) ?? '').trim();
      if (!name) throw new HttpError(400, `The ${label} name is required.`);
      if (name.length > maxLen) throw new HttpError(400, `The ${label} name cannot be longer than ${maxLen} characters.`);
      return name;
    };
    const ensureFree = async (name, exceptId = 0) => {
      const dup = await pool.query(`SELECT 1 FROM ${table} WHERE LOWER(name) = LOWER($1) AND ${idCol} <> $2`, [name, exceptId]);
      if (dup.rowCount) throw new HttpError(409, `The ${label} "${name}" already exists.`);
    };

    app.get(`/api/${route}`, auth, wrap(async (req, res) => {
      const { rows } = await pool.query(`
        SELECT x.${idCol} AS id, x.name, COUNT(p.product_id)::int AS products
          FROM ${table} x LEFT JOIN product p ON p.${idCol} = x.${idCol}
         GROUP BY x.${idCol} ORDER BY x.name`);
      res.json(rows);
    }));

    app.post(`/api/${route}`, auth, adminOnly, wrap(async (req, res) => {
      const name = readName(req.body);
      await ensureFree(name);
      const r = await pool.query(`INSERT INTO ${table} (name) VALUES ($1) RETURNING ${idCol}`, [name]);
      await log(req.user.id, 'catalog', `Created ${label} "${name}"`);
      res.status(201).json({ id: r.rows[0][idCol] });
    }));

    app.put(`/api/${route}/:id`, auth, adminOnly, wrap(async (req, res) => {
      const id = Number(req.params.id);
      const name = readName(req.body);
      await ensureFree(name, id);
      const r = await pool.query(`UPDATE ${table} SET name = $1 WHERE ${idCol} = $2`, [name, id]);
      if (!r.rowCount) throw new HttpError(404, `The ${label} was not found.`);
      await log(req.user.id, 'catalog', `Renamed ${label} ${id} to "${name}"`);
      res.json({ ok: true });
    }));

    app.delete(`/api/${route}/:id`, auth, adminOnly, wrap(async (req, res) => {
      const id = Number(req.params.id);
      try {
        const r = await pool.query(`DELETE FROM ${table} WHERE ${idCol} = $1 RETURNING name`, [id]);
        if (!r.rowCount) throw new HttpError(404, `The ${label} was not found.`);
        await log(req.user.id, 'catalog', `Deleted ${label} "${r.rows[0].name}"`);
        res.json({ ok: true });
      } catch (e) {
        if (e.code === '23503') throw new HttpError(409, inUseMsg);
        throw e;
      }
    }));
  }

  nameCatalog({ route: 'product-types', table: 'product_type', idCol: 'type_id', label: 'product type', maxLen: 50,
                inUseMsg: 'It cannot be deleted: some products use this type.' });
  nameCatalog({ route: 'suppliers', table: 'supplier', idCol: 'supplier_id', label: 'supplier', maxLen: 100,
                inUseMsg: 'It cannot be deleted: there are products from this supplier.' });

  // ----------------------------- PRODUCTS -----------------------------
  app.get('/api/products', auth, wrap(async (req, res) => {
    const { rows } = await pool.query(`
      SELECT p.product_id AS id, p.code, p.name, p.type_id AS "typeId", t.name AS type,
             p.supplier_id AS "supplierId", s.name AS supplier,
             p.purchase_price::float AS "purchasePrice", p.sale_price::float AS "salePrice",
             -- branches where the product is currently ACTIVE (HU-020)
             COALESCE((SELECT string_agg(b.name, ', ' ORDER BY b.name)
                         FROM product_branch pb JOIN branch b ON b.branch_id = pb.branch_id
                        WHERE pb.product_id = p.product_id AND pb.is_active), '') AS branches
        FROM product p
        JOIN product_type t ON t.type_id = p.type_id
        JOIN supplier s ON s.supplier_id = p.supplier_id
       ORDER BY p.name`);
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
        `INSERT INTO product (type_id, supplier_id, code, name, purchase_price, sale_price)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING product_id`,
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
        `UPDATE product SET type_id = $1, supplier_id = $2, code = $3, name = $4, purchase_price = $5, sale_price = $6
          WHERE product_id = $7`,
        [p.typeId, p.supplierId, p.code, p.name, p.purchasePrice, p.salePrice, id]);
      if (!r.rowCount) throw new HttpError(404, 'Product not found.');
      await log(req.user.id, 'catalog', `Edited product ${p.code} - ${p.name}`);
      res.json({ ok: true });
    } catch (e) { throw productError(e); }
  }));

  app.delete('/api/products/:id', auth, adminOnly, wrap(async (req, res) => {
    const id = Number(req.params.id);
    try {
      const r = await pool.query('DELETE FROM product WHERE product_id = $1 RETURNING code, name', [id]);
      if (!r.rowCount) throw new HttpError(404, 'Product not found.');
      await log(req.user.id, 'catalog', `Deleted product ${r.rows[0].code} - ${r.rows[0].name}`);
      res.json({ ok: true });
    } catch (e) {
      if (e.code === '23503') throw new HttpError(409, 'It cannot be deleted: the product has already been used in orders.');
      throw e;
    }
  }));
};
