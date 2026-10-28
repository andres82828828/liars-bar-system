// =====================================================================
//  Audit trail query (Administrator only)
//  Who did what and when. Filters: date range, user, category and free text.
//  Any other role that tries it gets 403 and the attempt itself is recorded.
// =====================================================================
const { parseDate, toId } = require('../validators');

module.exports = ({ app, pool, auth, adminOnly, wrap, HttpError, AUDIT_CATEGORIES }) => {

  const MAX_ROWS = 500;

  // Operations that require traceability (for the filter on the screen)
  app.get('/api/audit-log/categories', auth, adminOnly, (req, res) => {
    res.json(Object.entries(AUDIT_CATEGORIES).map(([id, description]) => ({ id, description })));
  });

  app.get('/api/audit-log', auth, adminOnly, wrap(async (req, res) => {
    const from = parseDate(req.query.from, 'start');
    const to = parseDate(req.query.to, 'end');
    if (from && to && from > to) throw new HttpError(400, 'The start date cannot be after the end date.');
    const userId = req.query.user_id ? toId(req.query.user_id) : null;
    if (req.query.user_id && !userId) throw new HttpError(400, 'Invalid user.');
    const category = req.query.category ? String(req.query.category) : null;
    if (category && !AUDIT_CATEGORIES[category] && category !== 'general') throw new HttpError(400, 'Invalid category.');
    const text = req.query.q ? String(req.query.q).trim().slice(0, 100) : null;

    const params = [from, to, userId, category, text ? `%${text}%` : null];
    const where = `
       WHERE ($1::date IS NULL OR l.created_at >= $1::date)
         AND ($2::date IS NULL OR l.created_at < $2::date + 1)
         AND ($3::int  IS NULL OR l.user_id = $3)
         AND ($4::text IS NULL OR l.category = $4)
         AND ($5::text IS NULL OR l.operation ILIKE $5)`;

    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_log l ${where}`, params);
    const { rows } = await pool.query(`
      SELECT l.log_id AS id, l.created_at AS "createdAt", l.category, l.operation,
             u.user_id AS "userId", u.username, u.full_name AS name, u.role
        FROM audit_log l JOIN app_user u ON u.user_id = l.user_id
      ${where}
       ORDER BY l.created_at DESC, l.log_id DESC
       LIMIT ${MAX_ROWS}`, params);

    res.json({ total: count.rows[0].n, shown: rows.length, limit: MAX_ROWS, rows });
  }));
};
