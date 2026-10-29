const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { pool } = require('./db');
const { migrate } = require('./migrate');
const { HttpError } = require('./validators');
const { logger } = require('./logger');

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 3 * 60 * 1000;      // exactly 3 minutes of inactivity (HU-004, RNF-07)

const app = express();
// Security headers (RNF-04, OWASP). The pages use inline handlers and Font Awesome from cdnjs.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: null
    }
  }
}));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ---------------------------------------------------------------------
//  Roles
// ---------------------------------------------------------------------
const ROLES = { ADMIN: 'Administrator', CASHIER: 'Cashier', WAITER: 'Waiter' };
const ALL_ROLES = Object.values(ROLES);

// ---------------------------------------------------------------------
//  Audit trail (HU: operation traceability)
//  Operations that require traceability, grouped by category. Every one of them
//  is saved in audit_log with WHO (user_id) and WHEN (created_at).
// ---------------------------------------------------------------------
const AUDIT_CATEGORIES = {
  auth:      'Authentication (login, logout, failed attempts, lockouts, password changes)',
  users:     'Users (create, activate, deactivate, password reset authorization)',
  branches:  'Branches and tables (create)',
  catalog:   'Catalog (products, product types, suppliers)',
  inventory: 'Inventory (stock entries, activate / deactivate per branch)',
  orders:    'Orders (create, add and remove products, cancel)',
  payments:  'Payments (register payment, close order, release table)',
  invoices:  'Invoices (generate)',
  reports:   'Reports (view and export sales)',
  security:  'Security (access denied)',
  system:    'System'
};

async function log(userId, category, operation) {
  try {
    await pool.query('INSERT INTO log_trazabilidad (id_usuario, categoria, operacion) VALUES ($1, $2, $3)',
      [userId, AUDIT_CATEGORIES[category] ? category : 'general', operation]);
  } catch (e) {
    logger.error('Could not write to the audit log', { message: e.message, category });
  }
}

// ---------------------------------------------------------------------
//  Active sessions in memory: token -> { user, lastSeen }
//  (the token is also stored in app_user.session_token)
// ---------------------------------------------------------------------
const sessions = new Map();
const replaced = new Map();   // tokens closed because the account was opened on another device: token -> time

const sessionAlive = (token) => {
  const s = sessions.get(token);
  return !!s && Date.now() - s.lastSeen < SESSION_TTL_MS;
};
const closeUserSessions = (userId) => {
  for (const [t, s] of sessions) if (s.user.id === userId) sessions.delete(t);
};

// ---------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);


// Runs several queries as ONE operation (all or nothing)
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Branch the user works on: the Administrator chooses it, everyone else uses their own
const branchOf = (user, chosen) => (user.role === ROLES.ADMIN ? Number(chosen) || null : user.branchId);
const canAccessBranch = (user, branchId) => user.role === ROLES.ADMIN || user.branchId === branchId;

// Money in Colombian pesos: dot as thousands separator, e.g. $55.000
const money = (n) => {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '-$' : '$') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
};

// ---------------------------------------------------------------------
//  Middlewares
// ---------------------------------------------------------------------
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token && replaced.has(token)) {
    return res.status(401).json({ code: 'SESSION_REPLACED', error: 'Your session was closed because the account was opened on another device.' });
  }
  if (!token || !sessionAlive(token)) {
    return res.status(401).json({ code: 'SESSION_EXPIRED', error: 'Session expired or invalid.' });
  }
  const s = sessions.get(token);
  s.lastSeen = Date.now();
  req.token = token;
  req.user = s.user;
  next();
}

// Allows only the given roles. The Administrator is ALWAYS allowed: it keeps its management
// permissions and can also do the Waiter and Cashier work (HU-030).
// Denied attempts are recorded in the audit trail.
function allow(...roles) {
  return (req, res, next) => {
    if (req.user.role === ROLES.ADMIN || roles.includes(req.user.role)) return next();
    log(req.user.id, 'security', `Access denied: ${req.method} ${req.originalUrl} (${req.user.role})`);
    const who = roles.length ? `${ROLES.ADMIN} or ${roles.join(' / ')}` : ROLES.ADMIN;
    res.status(403).json({ error: `Access denied: requires the ${who} profile.` });
  };
}
const adminOnly = allow();

// ---------------------------------------------------------------------
//  Routes
// ---------------------------------------------------------------------
const deps = {
  app, pool, auth, allow, adminOnly, log, wrap, tx, HttpError, branchOf, canAccessBranch, money,
  ROLES, ALL_ROLES, AUDIT_CATEGORIES, sessions, replaced, sessionAlive, closeUserSessions
};
require('./routes/auth')(deps);
require('./routes/users')(deps);
require('./routes/branches')(deps);
require('./routes/products')(deps);
require('./routes/inventory')(deps);
require('./routes/orders')(deps);
require('./routes/invoices')(deps);
require('./routes/reports')(deps);
require('./routes/audit')(deps);

// ---------------------------------------------------------------------
//  Errors
// ---------------------------------------------------------------------
app.use('/api', (req, res) => res.status(404).json({ error: 'Route not found.' }));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
  // RNF-23: technical details go to logs/error.log; the user only gets a generic message
  logger.error('Unhandled error', {
    method: req.method, url: req.originalUrl.split('?')[0], user: req.user ? req.user.id : null,
    message: err.message, code: err.code, stack: err.stack
  });
  res.status(500).json({ error: 'Internal server error.' });
});

// On startup: update the schema if needed and clear sessions left in the database
(async () => {
  try {
    const result = await migrate(pool);
    console.log('• Database: ' + result);
    await pool.query('UPDATE usuario SET token_sesion = NULL');
    app.listen(PORT, () => console.log(`✔ Liar's Bar running at http://localhost:${PORT}`));
  } catch (err) {
    logger.error('Could not start the server', { message: err.message, code: err.code });
    console.error('✖ Could not start:', err.message);
    console.error('  Check backend/.env and that PostgreSQL is running (first time: npm run init-db)');
    process.exit(1);
  }
})();
