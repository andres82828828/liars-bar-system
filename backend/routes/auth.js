// =====================================================================
//  Authentication (HU-001 … HU-006)
//  Login with bcrypt, lock after 3 failed attempts, single session per account,
//  logout, keep-alive and password change authorized by an administrator.
//  OWASP (RNF-04): login messages do not reveal whether the username exists, and failed
//  attempts are limited per IP address.
// =====================================================================
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { validatePassword } = require('../validators');

const MAX_ATTEMPTS = 3;
const BAD_CREDENTIALS = 'Wrong username or password.';
// Hash compared when the username does not exist, so both cases take the same time
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// Failed attempts per IP (login and password change): at most IP_MAX_FAILS every IP_WINDOW_MS
const IP_MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS_PER_IP) || 10;
const IP_WINDOW_MS = 15 * 60 * 1000;
const failsByIp = new Map();   // ip -> { count, since }

function ipBlocked(ip) {
  const f = failsByIp.get(ip);
  if (f && Date.now() - f.since > IP_WINDOW_MS) { failsByIp.delete(ip); return false; }
  return !!f && f.count >= IP_MAX_FAILS;
}
function ipFailed(ip) {
  const f = failsByIp.get(ip);
  if (!f || Date.now() - f.since > IP_WINDOW_MS) failsByIp.set(ip, { count: 1, since: Date.now() });
  else f.count++;
}
const TOO_MANY = { code: 'TOO_MANY_ATTEMPTS', error: 'Too many failed attempts from this device. Try again in 15 minutes.' };

// Same full name ignoring case, accents and repeated spaces (RF-24)
const normName = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();

module.exports = ({ app, pool, auth, log, wrap, HttpError, sessions, replaced, sessionAlive, closeUserSessions }) => {

  app.post('/api/login', wrap(async (req, res) => {
    const { username, password, force } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    if (ipBlocked(req.ip)) return res.status(429).json(TOO_MANY);

    const { rows } = await pool.query(
      `SELECT u.*, b.active AS branch_active FROM app_user u LEFT JOIN branch b ON b.branch_id = u.branch_id
        WHERE u.username = $1`, [String(username).trim()]);
    const u = rows[0];
    const ok = await bcrypt.compare(String(password), u ? u.password_hash : DUMMY_HASH);

    if (!u) {
      ipFailed(req.ip);
      return res.status(401).json({ code: 'BAD_CREDENTIALS', error: BAD_CREDENTIALS });
    }
    if (u.failed_attempts >= MAX_ATTEMPTS) {
      return res.status(423).json({ code: 'LOCKED', error: 'Account locked.' });
    }
    if (!ok) {
      ipFailed(req.ip);
      const r = await pool.query(
        'UPDATE app_user SET failed_attempts = failed_attempts + 1 WHERE user_id = $1 RETURNING failed_attempts', [u.user_id]);
      const attempts = r.rows[0].failed_attempts;
      await log(u.user_id, 'auth', `Failed login attempt (${attempts}/${MAX_ATTEMPTS})`);
      if (attempts >= MAX_ATTEMPTS) {
        await log(u.user_id, 'auth', 'Account locked after failed attempts');
        return res.status(423).json({ code: 'LOCKED', error: 'Account locked.' });
      }
      return res.status(401).json({ code: 'BAD_CREDENTIALS', error: BAD_CREDENTIALS });
    }

    // From here on the password is right, so these messages reveal nothing to an attacker
    if (!u.active) {
      return res.status(403).json({ code: 'INACTIVE', error: 'This account has been deactivated by the administrator.' });
    }
    if (u.branch_id && !u.branch_active) {
      return res.status(403).json({ code: 'BRANCH_INACTIVE', error: 'Your branch is inactive. Contact the administrator.' });
    }
    // Single session per account (HU-006). With "force" the old one is closed.
    if (u.session_token && sessionAlive(u.session_token) && !force) {
      return res.status(409).json({ code: 'ACTIVE_SESSION', error: 'The account already has an active session.' });
    }

    // If the account had another open session, it is invalidated
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
  // RF-24: the user is identified by full name AND username. Only works if an Administrator
  // authorized it first (valid for a limited time, single use).
  app.post('/api/change-password', wrap(async (req, res) => {
    const { fullName, username, newPassword } = req.body || {};
    if (!fullName || !username || !newPassword) throw new HttpError(400, 'Please fill in all fields.');
    if (ipBlocked(req.ip)) return res.status(429).json(TOO_MANY);

    const { rows } = await pool.query(
      `SELECT user_id, full_name, active, (reset_authorized_until IS NOT NULL AND reset_authorized_until > NOW()) AS authorized
         FROM app_user WHERE username = $1`, [String(username).trim()]);
    const u = rows[0];
    // Same generic answer if the username does not exist or the name does not match it
    if (!u || normName(u.full_name) !== normName(fullName)) {
      ipFailed(req.ip);
      return res.status(400).json({ code: 'NO_MATCH', error: 'The full name and username do not match any account.' });
    }
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
