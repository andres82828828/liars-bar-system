// =====================================================================
//  Authentication (HU-001 … HU-006)
//  Login with bcrypt, lock after 3 failed attempts, single session per account,
//  logout, keep-alive and password change authorized by an administrator.
// =====================================================================
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { validatePassword } = require('../validators');

const MAX_ATTEMPTS = 3;

module.exports = ({ app, pool, auth, log, wrap, HttpError, sessions, replaced, sessionAlive, closeUserSessions }) => {

  app.post('/api/login', wrap(async (req, res) => {
    const { username, password, force } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

    const { rows } = await pool.query('SELECT * FROM app_user WHERE username = $1', [String(username).trim()]);
    const u = rows[0];
    if (!u) return res.status(404).json({ code: 'NO_USER', error: 'The username does not exist in the system.' });

    if (!u.active) {
      return res.status(403).json({ code: 'INACTIVE', error: 'This account has been deactivated by the administrator.' });
    }
    if (u.failed_attempts >= MAX_ATTEMPTS) {
      return res.status(423).json({ code: 'LOCKED', error: 'Account locked.' });
    }
    // Single session per account (HU-006). With "force" (and the right password) the old one is closed.
    if (u.session_token && sessionAlive(u.session_token) && !force) {
      return res.status(409).json({ code: 'ACTIVE_SESSION', error: 'The account already has an active session.' });
    }

    const ok = await bcrypt.compare(String(password), u.password_hash);
    if (!ok) {
      const r = await pool.query(
        'UPDATE app_user SET failed_attempts = failed_attempts + 1 WHERE user_id = $1 RETURNING failed_attempts', [u.user_id]);
      const attempts = r.rows[0].failed_attempts;
      await log(u.user_id, 'auth', `Failed login attempt (${attempts}/${MAX_ATTEMPTS})`);
      if (attempts >= MAX_ATTEMPTS) {
        await log(u.user_id, 'auth', 'Account locked after failed attempts');
        return res.status(423).json({ code: 'LOCKED', error: 'Account locked.' });
      }
      return res.status(401).json({ code: 'BAD_PASSWORD', attempts, max: MAX_ATTEMPTS, error: 'Wrong password.' });
    }

    // If the account had another open session, it is invalidated (the password was already verified)
    if (u.session_token && sessions.has(u.session_token)) {
      sessions.delete(u.session_token);
      replaced.set(u.session_token, Date.now());
      await log(u.user_id, 'auth', 'Closed the previous session to sign in on another device');
    }
    for (const [t, ts] of replaced) if (Date.now() - ts > 3600000) replaced.delete(t);   // cleanup (1 h)

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('UPDATE app_user SET failed_attempts = 0, session_token = $1 WHERE user_id = $2', [token, u.user_id]);

    const user = { id: u.user_id, username: u.username, name: u.full_name, role: u.role, branchId: u.branch_id };
    sessions.set(token, { user, lastSeen: Date.now() });
    await log(u.user_id, 'auth', 'Signed in');
    res.json({ token, user });
  }));

  // Password change from the login screen (no session and WITHOUT the current password).
  // Only works if an Administrator authorized it first (valid for a limited time, single use).
  app.post('/api/change-password', wrap(async (req, res) => {
    const { username, newPassword } = req.body || {};
    if (!username || !newPassword) throw new HttpError(400, 'Please fill in all fields.');

    const { rows } = await pool.query(
      `SELECT user_id, active, (reset_authorized_until IS NOT NULL AND reset_authorized_until > NOW()) AS authorized
         FROM app_user WHERE username = $1`, [String(username).trim()]);
    const u = rows[0];
    if (!u) return res.status(404).json({ code: 'NO_USER', error: 'The username does not exist in the system.' });
    if (!u.active) return res.status(403).json({ code: 'INACTIVE', error: 'This account has been deactivated by the administrator.' });
    if (!u.authorized) {
      return res.status(403).json({ code: 'NOT_AUTHORIZED', error: 'The administrator has not authorized your password change yet. Ask them to do it from Users.' });
    }
    validatePassword(newPassword);

    // New hash, account unlocked, authorization used up and open sessions closed
    await pool.query(
      `UPDATE app_user SET password_hash = $1, failed_attempts = 0, session_token = NULL, reset_authorized_until = NULL
        WHERE user_id = $2`, [await bcrypt.hash(newPassword, 10), u.user_id]);
    closeUserSessions(u.user_id);
    await log(u.user_id, 'auth', 'Changed their password with administrator authorization');
    res.json({ ok: true });
  }));

  app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

  app.post('/api/keepalive', auth, (req, res) => res.json({ ok: true }));

  app.post('/api/logout', auth, wrap(async (req, res) => {
    sessions.delete(req.token);
    await pool.query('UPDATE app_user SET session_token = NULL WHERE user_id = $1', [req.user.id]);
    await log(req.user.id, 'auth', 'Signed out');
    res.json({ ok: true });
  }));
};

module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
