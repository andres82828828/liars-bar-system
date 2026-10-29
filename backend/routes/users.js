// =====================================================================
//  Users (Administrator only): list, create, edit (name, role, branch),
//  activate / deactivate, authorize a password change
// =====================================================================
const bcrypt = require('bcryptjs');
const { validateUser, validateUserEdit } = require('../validators');
const { MAX_ATTEMPTS } = require('./auth');

const RESET_TTL_MIN = 30;     // minutes the administrator's password-change authorization lasts

module.exports = ({ app, pool, auth, adminOnly, log, wrap, HttpError, closeUserSessions }) => {

  app.get('/api/users', auth, adminOnly, wrap(async (req, res) => {
    const { rows } = await pool.query(`
      SELECT u.id_usuario AS id, u.username, u.nombre_completo AS name, u.rol AS role,
             u.activo AS active, (u.intentos_fallidos >= $1) AS locked, u.id_sede AS "branchId", b.nombre AS branch,
             (u.reset_autorizado_hasta IS NOT NULL AND u.reset_autorizado_hasta > NOW()) AS "resetAuthorized"
        FROM usuario u LEFT JOIN sede b ON b.id_sede = u.id_sede
       ORDER BY u.id_usuario`, [MAX_ATTEMPTS]);
    res.json(rows);
  }));

  app.post('/api/users', auth, adminOnly, wrap(async (req, res) => {
    const { fullName, username, password, role, branchId } = validateUser(req.body);

    if (branchId) {
      const b = await pool.query('SELECT activo AS active FROM sede WHERE id_sede = $1', [branchId]);
      if (!b.rowCount) throw new HttpError(400, 'The selected branch does not exist.');
      if (!b.rows[0].active) throw new HttpError(400, 'The selected branch is inactive.');
    }
    // Case-insensitive: "APerez" and "aperez" are considered the same user
    const dup = await pool.query('SELECT 1 FROM usuario WHERE LOWER(username) = LOWER($1)', [username]);
    if (dup.rowCount) throw new HttpError(409, 'The username already exists in the system.');

    const hash = await bcrypt.hash(password, 10);
    let r;
    try {
      r = await pool.query(
        `INSERT INTO usuario (id_sede, username, password_hash, nombre_completo, rol)
         VALUES ($1, $2, $3, $4, $5) RETURNING id_usuario AS user_id`, [branchId, username, hash, fullName, role]);
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'The username already exists in the system.');   // two admins at once
      if (e.code === '23503') throw new HttpError(400, 'The selected branch does not exist.');
      throw e;
    }
    await log(req.user.id, 'users', `Created user "${username}" (${role})`);
    res.status(201).json({ id: r.rows[0].user_id });
  }));

  // Edit a user (RF-01, profiles and permissions): full name, role and branch.
  // If the role or the branch changes, the user's open session is closed so the new permissions apply.
  app.put('/api/users/:id', auth, adminOnly, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { fullName, role, branchId } = validateUserEdit(req.body);
    const cur = await pool.query('SELECT username, rol AS role, id_sede AS branch_id FROM usuario WHERE id_usuario = $1', [id]);
    if (!cur.rowCount) throw new HttpError(404, 'User not found.');
    const before = cur.rows[0];
    if (id === req.user.id && role !== before.role) throw new HttpError(400, 'You cannot change your own role; ask another administrator.');
    if (branchId) {
      const b = await pool.query('SELECT activo AS active FROM sede WHERE id_sede = $1', [branchId]);
      if (!b.rowCount) throw new HttpError(400, 'The selected branch does not exist.');
      if (!b.rows[0].active) throw new HttpError(400, 'The selected branch is inactive.');
    }

    await pool.query('UPDATE usuario SET nombre_completo = $1, rol = $2, id_sede = $3 WHERE id_usuario = $4', [fullName, role, branchId, id]);
    const permissionsChanged = role !== before.role || branchId !== before.branch_id;
    if (permissionsChanged && id !== req.user.id) {
      closeUserSessions(id);
      await pool.query('UPDATE usuario SET token_sesion = NULL WHERE id_usuario = $1', [id]);
    }
    await log(req.user.id, 'users', `Edited user "${before.username}": ${fullName}, ${role}` + (branchId ? ` (branch ${branchId})` : ''));
    res.json({ ok: true, sessionClosed: permissionsChanged && id !== req.user.id });
  }));

  // The Administrator AUTHORIZES someone else to change their password (they do not type it).
  // The user then goes to "Forgot password?" on the login screen. Lasts RESET_TTL_MIN minutes.
  app.put('/api/users/:id/reset', auth, adminOnly, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw new HttpError(400, 'You cannot authorize your own password change; ask another administrator.');

    const r = await pool.query(
      `UPDATE usuario SET reset_autorizado_hasta = NOW() + ($1 * INTERVAL '1 minute')
        WHERE id_usuario = $2 RETURNING username`, [RESET_TTL_MIN, id]);
    if (!r.rowCount) throw new HttpError(404, 'User not found.');

    await log(req.user.id, 'users', `Authorized the password change of user "${r.rows[0].username}"`);
    res.json({ ok: true, minutes: RESET_TTL_MIN });
  }));

  // The Administrator cancels an authorization they gave
  app.delete('/api/users/:id/reset', auth, adminOnly, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const r = await pool.query('UPDATE usuario SET reset_autorizado_hasta = NULL WHERE id_usuario = $1 RETURNING username', [id]);
    if (!r.rowCount) throw new HttpError(404, 'User not found.');
    await log(req.user.id, 'users', `Cancelled the password change authorization of "${r.rows[0].username}"`);
    res.json({ ok: true });
  }));

  app.patch('/api/users/:id/status', auth, adminOnly, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { active } = req.body || {};
    if (typeof active !== 'boolean') throw new HttpError(400, 'Invalid "active" value.');
    if (id === req.user.id && !active) throw new HttpError(400, 'You cannot deactivate your own account.');

    // Activating also removes the lock caused by failed attempts
    const r = await pool.query(
      `UPDATE usuario
          SET activo = $1,
              intentos_fallidos = CASE WHEN $1 THEN 0 ELSE intentos_fallidos END,
              token_sesion = CASE WHEN $1 THEN token_sesion ELSE NULL END
        WHERE id_usuario = $2 RETURNING username`, [active, id]);
    if (!r.rowCount) throw new HttpError(404, 'User not found.');

    if (!active) closeUserSessions(id);
    await log(req.user.id, 'users', `${active ? 'Activated' : 'Deactivated'} user "${r.rows[0].username}"`);
    res.json({ ok: true });
  }));
};
