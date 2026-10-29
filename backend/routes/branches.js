// =====================================================================
//  Branches and tables (RF-02, RF-03)
//  Query: everyone (Cashier / Waiter only their branch) · Create, edit, activate / deactivate: Administrator
//  Master records are never deleted: they are deactivated so the history stays intact.
//    Branch → branch.active  ·  Table → bar_table.status = 'inactive'
// =====================================================================
module.exports = ({ app, pool, auth, adminOnly, log, wrap, HttpError, branchOf, ROLES, closeUserSessions }) => {

  // Validates the branch fields (create and edit). exceptId = the branch being edited.
  async function readBranch(body, exceptId = 0) {
    const name = String((body || {}).name ?? '').trim();
    const address = String((body || {}).address ?? '').trim();
    if (!name || !address) throw new HttpError(400, 'Please fill in all branch fields.');
    if (name.length > 50) throw new HttpError(400, 'The branch name cannot be longer than 50 characters.');
    if (address.length > 100) throw new HttpError(400, 'The address cannot be longer than 100 characters.');
    const dup = await pool.query('SELECT 1 FROM sede WHERE LOWER(nombre) = LOWER($1) AND id_sede <> $2', [name, exceptId]);
    if (dup.rowCount) throw new HttpError(409, 'A branch with that name already exists.');
    return { name, address };
  }

  // Validates a table number and that it is not repeated in the branch
  async function readTableNumber(body, branchId, exceptId = 0) {
    const number = Number((body || {}).number);
    if (!Number.isInteger(number) || number < 1 || number > 9999) throw new HttpError(400, 'Enter a valid table number (1 to 9999).');
    const dup = await pool.query('SELECT 1 FROM mesa WHERE id_sede = $1 AND numero = $2 AND id_mesa <> $3', [branchId, number, exceptId]);
    if (dup.rowCount) throw new HttpError(409, `Table #${number} already exists in that branch.`);
    return number;
  }

  // ----------------------------- BRANCHES -----------------------------
  app.get('/api/branches', auth, wrap(async (req, res) => {
    const { rows } = req.user.role === ROLES.ADMIN
      ? await pool.query('SELECT id_sede AS id, nombre AS name, direccion AS address, activo AS active FROM sede ORDER BY id_sede')
      : await pool.query('SELECT id_sede AS id, nombre AS name, direccion AS address, activo AS active FROM sede WHERE id_sede = $1', [req.user.branchId]);
    res.json(rows);
  }));

  app.post('/api/branches', auth, adminOnly, wrap(async (req, res) => {
    const { name, address } = await readBranch(req.body);
    const r = await pool.query('INSERT INTO sede (nombre, direccion) VALUES ($1, $2) RETURNING id_sede AS branch_id', [name, address]);
    await log(req.user.id, 'branches', `Created branch "${name}"`);
    res.status(201).json({ id: r.rows[0].branch_id });
  }));

  app.put('/api/branches/:id', auth, adminOnly, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { name, address } = await readBranch(req.body, id);
    const r = await pool.query('UPDATE sede SET nombre = $1, direccion = $2 WHERE id_sede = $3 RETURNING id_sede AS branch_id', [name, address, id]);
    if (!r.rowCount) throw new HttpError(404, 'Branch not found.');
    await log(req.user.id, 'branches', `Edited branch ${id}: "${name}", ${address}`);
    res.json({ ok: true });
  }));

  // Deactivating a branch: no open orders allowed. Its staff can no longer sign in until it is reactivated.
  app.patch('/api/branches/:id/status', auth, adminOnly, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { active } = req.body || {};
    if (typeof active !== 'boolean') throw new HttpError(400, 'Invalid "active" value.');
    if (!active) {
      const open = await pool.query(`SELECT COUNT(*)::int AS n FROM pedido o JOIN mesa t ON t.id_mesa = o.id_mesa
                                      WHERE t.id_sede = $1 AND o.estado = 'open'`, [id]);
      if (open.rows[0].n) throw new HttpError(409, `The branch cannot be deactivated: it has ${open.rows[0].n} open order(s). Charge or cancel them first.`);
    }
    const r = await pool.query('UPDATE sede SET activo = $1 WHERE id_sede = $2 RETURNING nombre AS name', [active, id]);
    if (!r.rowCount) throw new HttpError(404, 'Branch not found.');
    if (!active) {
      const staff = await pool.query('UPDATE usuario SET token_sesion = NULL WHERE id_sede = $1 RETURNING id_usuario AS user_id', [id]);
      staff.rows.forEach((u) => closeUserSessions(u.user_id));
    }
    await log(req.user.id, 'branches', `${active ? 'Activated' : 'Deactivated'} branch "${r.rows[0].name}"`);
    res.json({ ok: true });
  }));

  // ----------------------------- TABLES -----------------------------
  // Tables of a branch with their open order (if any)
  app.get('/api/tables', auth, wrap(async (req, res) => {
    const branchId = branchOf(req.user, req.query.branch_id);    // Cashier and Waiter only see their own branch
    if (!branchId) return res.json([]);
    const { rows } = await pool.query(
      `SELECT t.id_mesa AS id, t.numero AS number, t.estado AS status,
              o.id_pedido AS "orderId", o.codigo_unico AS "orderCode"
         FROM mesa t
         LEFT JOIN pedido o ON o.id_mesa = t.id_mesa AND o.estado = 'open'
        WHERE t.id_sede = $1 ORDER BY t.numero`, [branchId]);
    res.json(rows);
  }));

  app.post('/api/tables', auth, adminOnly, wrap(async (req, res) => {
    const branchId = Number((req.body || {}).branchId);
    if (!Number.isInteger(branchId) || branchId < 1) throw new HttpError(400, 'Select a branch and enter a valid table number (1 to 9999).');
    const b = await pool.query('SELECT nombre AS name FROM sede WHERE id_sede = $1', [branchId]);
    if (!b.rowCount) throw new HttpError(400, 'The selected branch does not exist.');
    const number = await readTableNumber(req.body, branchId);

    const r = await pool.query('INSERT INTO mesa (id_sede, numero) VALUES ($1, $2) RETURNING id_mesa AS table_id', [branchId, number]);
    await log(req.user.id, 'branches', `Created table #${number} in branch "${b.rows[0].name}"`);
    res.status(201).json({ id: r.rows[0].table_id });
  }));

  // Change the table number
  app.put('/api/tables/:id', auth, adminOnly, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const t = await pool.query('SELECT id_sede AS branch_id, numero AS number FROM mesa WHERE id_mesa = $1', [id]);
    if (!t.rowCount) throw new HttpError(404, 'Table not found.');
    const number = await readTableNumber(req.body, t.rows[0].branch_id, id);
    await pool.query('UPDATE mesa SET numero = $1 WHERE id_mesa = $2', [number, id]);
    await log(req.user.id, 'branches', `Renumbered table #${t.rows[0].number} to #${number} (branch ${t.rows[0].branch_id})`);
    res.json({ ok: true });
  }));

  // Availability of a table: an inactive table cannot receive orders. An occupied table cannot be deactivated.
  app.patch('/api/tables/:id/status', auth, adminOnly, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { active } = req.body || {};
    if (typeof active !== 'boolean') throw new HttpError(400, 'Invalid "active" value.');
    const t = await pool.query('SELECT numero AS number, estado AS status FROM mesa WHERE id_mesa = $1', [id]);
    if (!t.rowCount) throw new HttpError(404, 'Table not found.');
    const table = t.rows[0];
    if (!active && table.status === 'occupied') throw new HttpError(409, `Table #${table.number} has an open order: charge or cancel it before deactivating the table.`);
    if (active && table.status !== 'inactive') return res.json({ ok: true });
    await pool.query('UPDATE mesa SET estado = $1 WHERE id_mesa = $2', [active ? 'available' : 'inactive', id]);
    await log(req.user.id, 'branches', `${active ? 'Activated' : 'Deactivated'} table #${table.number} (table id ${id})`);
    res.json({ ok: true });
  }));
};
