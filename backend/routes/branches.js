// =====================================================================
//  Branches and tables
//  Query: everyone (Cashier / Waiter only their branch) · Create: Administrator
// =====================================================================
module.exports = ({ app, pool, auth, adminOnly, log, wrap, HttpError, branchOf, ROLES }) => {

  app.get('/api/branches', auth, wrap(async (req, res) => {
    const { rows } = req.user.role === ROLES.ADMIN
      ? await pool.query('SELECT branch_id AS id, name, address FROM branch ORDER BY branch_id')
      : await pool.query('SELECT branch_id AS id, name, address FROM branch WHERE branch_id = $1', [req.user.branchId]);
    res.json(rows);
  }));

  app.post('/api/branches', auth, adminOnly, wrap(async (req, res) => {
    const name = String((req.body || {}).name ?? '').trim();
    const address = String((req.body || {}).address ?? '').trim();
    if (!name || !address) throw new HttpError(400, 'Please fill in all branch fields.');
    if (name.length > 50) throw new HttpError(400, 'The branch name cannot be longer than 50 characters.');
    if (address.length > 100) throw new HttpError(400, 'The address cannot be longer than 100 characters.');
    const dup = await pool.query('SELECT 1 FROM branch WHERE LOWER(name) = LOWER($1)', [name]);
    if (dup.rowCount) throw new HttpError(409, 'A branch with that name already exists.');

    const r = await pool.query('INSERT INTO branch (name, address) VALUES ($1, $2) RETURNING branch_id', [name, address]);
    await log(req.user.id, 'branches', `Created branch "${name}"`);
    res.status(201).json({ id: r.rows[0].branch_id });
  }));

  // Tables of a branch with their open order (if any)
  app.get('/api/tables', auth, wrap(async (req, res) => {
    const branchId = branchOf(req.user, req.query.branch_id);    // Cashier and Waiter only see their own branch
    if (!branchId) return res.json([]);
    const { rows } = await pool.query(
      `SELECT t.table_id AS id, t.number, t.status,
              o.order_id AS "orderId", o.unique_code AS "orderCode"
         FROM bar_table t
         LEFT JOIN customer_order o ON o.table_id = t.table_id AND o.status = 'open'
        WHERE t.branch_id = $1 ORDER BY t.number`, [branchId]);
    res.json(rows);
  }));

  app.post('/api/tables', auth, adminOnly, wrap(async (req, res) => {
    const branchId = Number((req.body || {}).branchId);
    const number = Number((req.body || {}).number);
    if (!Number.isInteger(branchId) || branchId < 1 || !Number.isInteger(number) || number < 1 || number > 9999) {
      throw new HttpError(400, 'Select a branch and enter a valid table number (1 to 9999).');
    }
    const b = await pool.query('SELECT name FROM branch WHERE branch_id = $1', [branchId]);
    if (!b.rowCount) throw new HttpError(400, 'The selected branch does not exist.');
    const dup = await pool.query('SELECT 1 FROM bar_table WHERE branch_id = $1 AND number = $2', [branchId, number]);
    if (dup.rowCount) throw new HttpError(409, `Table #${number} already exists in that branch.`);

    const r = await pool.query('INSERT INTO bar_table (branch_id, number) VALUES ($1, $2) RETURNING table_id', [branchId, number]);
    await log(req.user.id, 'branches', `Created table #${number} in branch "${b.rows[0].name}"`);
    res.status(201).json({ id: r.rows[0].table_id });
  }));
};
