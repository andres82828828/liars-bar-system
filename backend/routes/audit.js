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
       WHERE ($1::date IS NULL OR l.fecha_hora >= $1::date)
         AND ($2::date IS NULL OR l.fecha_hora < $2::date + 1)
         AND ($3::int  IS NULL OR l.id_usuario = $3)
         AND ($4::text IS NULL OR l.categoria = $4)
         AND ($5::text IS NULL OR l.operacion ILIKE $5)`;

    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM log_trazabilidad l ${where}`, params);
    const { rows } = await pool.query(`
      SELECT l.id_log AS id, l.fecha_hora AS "createdAt", l.categoria AS category, l.operacion AS operation,
             u.id_usuario AS "userId", u.username, u.nombre_completo AS name, u.rol AS role
        FROM log_trazabilidad l JOIN usuario u ON u.id_usuario = l.id_usuario
      ${where}
       ORDER BY l.fecha_hora DESC, l.id_log DESC
       LIMIT ${MAX_ROWS}`, params);

    res.json({ total: count.rows[0].n, shown: rows.length, limit: MAX_ROWS, rows });
  }));
};
