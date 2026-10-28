// =====================================================================
//  Shared error class and input validation (the frontend applies the same rules)
// =====================================================================

// Error with an HTTP status, so the frontend gets a clear message
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ROLE_NAMES = ['Administrator', 'Cashier', 'Waiter'];
const NAME_RE = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' .-]+$/;
const USERNAME_RE = /^[A-Za-z0-9._-]+$/;

// Password rule: 8 to 64 characters, one uppercase letter, one number and no spaces
function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 8 || !/[A-Z]/.test(p) || !/\d/.test(p)) {
    throw new HttpError(400, 'The password must have at least 8 characters, one uppercase letter and one number.');
  }
  if (p.length > 64) throw new HttpError(400, 'The password cannot be longer than 64 characters.');
  if (/\s/.test(p)) throw new HttpError(400, 'The password cannot contain spaces.');
}

// Full validation of a new user (avoids 500 errors caused by invalid data)
function validateUser(b = {}) {
  const fullName = String(b.fullName ?? '').trim().replace(/\s+/g, ' ');
  const username = String(b.username ?? '').trim();
  const password = typeof b.password === 'string' ? b.password : '';
  const role = String(b.role ?? '');

  if (!fullName || !username || !password || !role) throw new HttpError(400, 'Please fill in all required fields.');
  if (fullName.length < 3 || fullName.length > 100) throw new HttpError(400, 'The full name must be between 3 and 100 characters.');
  if (!NAME_RE.test(fullName)) throw new HttpError(400, 'The full name can only contain letters, spaces, periods, hyphens and apostrophes.');
  if (username.length < 3 || username.length > 50) throw new HttpError(400, 'The username must be between 3 and 50 characters.');
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, 'The username can only contain letters without accents, numbers, period, hyphen or underscore (no spaces).');
  }
  if (!ROLE_NAMES.includes(role)) throw new HttpError(400, 'Invalid role.');
  validatePassword(password);
  if (password.toLowerCase().includes(username.toLowerCase())) {
    throw new HttpError(400, 'The password cannot contain the username.');
  }

  let branchId = null;
  if (role !== 'Administrator') {
    branchId = Number(b.branchId);
    if (!Number.isInteger(branchId) || branchId < 1) throw new HttpError(400, 'Select a branch for this role.');
  }
  return { fullName, username, password, role, branchId };
}

// Validation of an edited user (RF-01): name, role and branch. Username and password do not change here.
function validateUserEdit(b = {}) {
  const fullName = String(b.fullName ?? '').trim().replace(/\s+/g, ' ');
  const role = String(b.role ?? '');
  if (!fullName || !role) throw new HttpError(400, 'Please fill in all required fields.');
  if (fullName.length < 3 || fullName.length > 100) throw new HttpError(400, 'The full name must be between 3 and 100 characters.');
  if (!NAME_RE.test(fullName)) throw new HttpError(400, 'The full name can only contain letters, spaces, periods, hyphens and apostrophes.');
  if (!ROLE_NAMES.includes(role)) throw new HttpError(400, 'Invalid role.');
  let branchId = null;
  if (role !== 'Administrator') {
    branchId = Number(b.branchId);
    if (!Number.isInteger(branchId) || branchId < 1) throw new HttpError(400, 'Select a branch for this role.');
  }
  return { fullName, role, branchId };
}

// Positive integer id or null
const toId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 && v !== '' && v !== null && v !== true ? Number(v) : null);

// Date in YYYY-MM-DD format (used by report and audit filters)
function parseDate(v, label) {
  if (v === undefined || v === '') return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(s + 'T00:00:00').getTime())) {
    throw new HttpError(400, `Invalid ${label} date (expected YYYY-MM-DD).`);
  }
  return s;
}

module.exports = { HttpError, validatePassword, validateUser, validateUserEdit, toId, parseDate };
