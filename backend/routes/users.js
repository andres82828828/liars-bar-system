// =====================================================================
//  Users (Administrator only): list, create, activate / deactivate,
//  authorize a password change
// =====================================================================
const bcrypt = require('bcryptjs');
const { validateUser } = require('../validators');
const { MAX_ATTEMPTS } = require('./auth');

const RESET_TTL_MIN = 30;     // minutes the administrator's password-change authorization lasts

module.exports = ({ app, pool, auth, adminOnly, log, wrap, HttpError, closeUserSessions }) => {

  app.get('/api/users', auth, adminOnly, wrap(async (req, res) => {
    const { rows } = await pool.query(`
      SELECT u.user_id AS id, u.username, u.full_name AS name, u.role,
             u.active, (u.failed_attempts >= $1) AS locked, b.name AS branch,
             (u.reset_authorized_until IS NOT NULL AND u.reset_authorized_until > NOW()) AS "resetAuthorized"
        FROM app_user u LEFT JOIN branch b ON b.branch_id = u.branch_id
       ORDER BY u.user_id`, [MAX_ATTEMPTS]);
    res.json(rows);
  }));

  app.post('/api/users', auth, adminOnly, wrap(async (req, res) => {
    const { fullName, username, password, role, branchId } = validateUser(req.body);

    if (branchId) {
      const b = await pool.query('SELECT 1 FROM branch WHERE branch_id = $1', [branchId]);
      if (!b.rowCount) throw new HttpError(400, 'The selected branch does not exist.');
    }
    // Case-insensitive: "APerez" and "aperez" are considered the same user
    const dup = await pool.query('SELECT 1 FROM app_user WHERE LOWER(username) = LOWER($1)', [username]);
    if (dup.rowCount) throw new HttpError(409, 'The username already exists in the system.');

    const hash = await bcrypt.hash(password, 10);
    let r;
    try {
      r = await pool.query(
        `INSERT INTO app_user (branch_id, username, password_hash, full_name, role)
         VALUES ($1, $2, $3, $4, $5) RETURNING user_id`, [branchId, username, hash, fullName, role]);
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'The username already exists in the system.');   // two admins at once
      if (e.code === '23503') throw new HttpError(400, 'The selected branch does not exist.');
      throw e;
    }
    await log(req.user.id, 'users', `Created user "${username}" (${role})`);
    res.status(201).json({ id: r.rows[0].user_id });
  }));

  // The Administrator AUTHORIZES someone else to change their password (they do not type it).
  // The user then goes to "Forgot password?" on the login screen. Lasts RESET_TTL_MIN minutes.
  app.put('/api/users/:id/reset', auth, adminOnly, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw new HttpError(400, 'You cannot authorize your own password change; ask another administrator.');

    const r = await pool.query(
      `UPDATE app_user SET reset_authorized_until = NOW() + ($1 * INTERVAL '1 minute')
        WHERE user_id = $2 RETURNING username`, [RESET_TTL_MIN, id]);
    if (!r.rowCount) throw new HttpError(404, 'User not found.');

    await log(req.user.id, 'users', `Authorized the password change of user "${r.rows[0].username}"`);
    res.json({ ok: true, minutes: RESET_TTL_MIN });
  }));

  // The Administrator cancels an authorization they gave
  app.delete('/api/users/:id/reset', auth, adminOnly, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const r = await pool.query('UPDATE app_user SET reset_authorized_until = NULL WHERE user_id = $1 RETURNING username', [id]);
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
      `UPDATE app_user
          SET active = $1,
              failed_attempts = CASE WHEN $1 THEN 0 ELSE failed_attempts END,
              session_token = CASE WHEN $1 THEN session_token ELSE NULL END
        WHERE user_id = $2 RETURNING username`, [active, id]);
    if (!r.rowCount) throw new HttpError(404, 'User not found.');

    if (!active) closeUserSessions(id);
    await log(req.user.id, 'users', `${active ? 'Activated' : 'Deactivated'} user "${r.rows[0].username}"`);
    res.json({ ok: true });
  }));
};
