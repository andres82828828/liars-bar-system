// =====================================================================
//  Sales report (Administrator) and Excel export
//  Only CLOSED (paid) orders count as sales. Dates filter by payment date.
//  Profit = revenue (unit_price x qty) - cost (unit_cost x qty), using the prices frozen
//  in each order line, so later price changes do not alter past reports.
// =====================================================================
const ExcelJS = require('exceljs');
const { parseDate } = require('../validators');

module.exports = ({ app, pool, auth, adminOnly, log, wrap, HttpError, ROLES }) => {

  const METHOD_NAMES = { cash: 'Cash', credit_card: 'Credit card', debit_card: 'Debit card' };
  const cents = (n) => Math.round(Number(n) * 100);
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  const marginPct = (profit, revenue) => (revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0);
  const pad = (n) => String(n).padStart(2, '0');
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  // Reads and validates the filters. Default: from the 1st of the current month to today.
  async function readFilters(q) {
    const today = new Date();
    const from = parseDate(q.from, 'start') || isoDay(new Date(today.getFullYear(), today.getMonth(), 1));
    const to = parseDate(q.to, 'end') || isoDay(today);
    if (from > to) throw new HttpError(400, 'The start date cannot be after the end date.');

    let branch = null;
    if (q.branch_id && q.branch_id !== 'all') {
      const id = Number(q.branch_id);
      const r = Number.isInteger(id) ? await pool.query('SELECT branch_id AS id, name FROM branch WHERE branch_id = $1', [id]) : { rowCount: 0 };
      if (!r.rowCount) throw new HttpError(400, 'The selected branch does not exist.');
      branch = r.rows[0];
    }
    return { from, to, branch };
  }

  // Sales query: every product line of the closed orders in the period
  const SALES_FROM = `
      FROM customer_order o
      JOIN payment pa      ON pa.order_id = o.order_id
      JOIN bar_table t     ON t.table_id = o.table_id
      JOIN branch b        ON b.branch_id = t.branch_id
      JOIN order_detail d  ON d.order_id = o.order_id
      JOIN product p       ON p.product_id = d.product_id
      JOIN product_type ty ON ty.type_id = p.type_id
     WHERE o.status = 'closed'
       AND pa.paid_at >= $1::date AND pa.paid_at < $2::date + 1
       AND ($3::int IS NULL OR b.branch_id = $3)`;

  async function salesReport(f) {
    const params = [f.from, f.to, f.branch ? f.branch.id : null];

    const byProduct = (await pool.query(`
      SELECT b.name AS branch, p.code, p.name AS product, ty.name AS type,
             SUM(d.quantity)::int AS units,
             SUM(d.quantity * d.unit_price)::float AS revenue,
             SUM(d.quantity * d.unit_cost)::float AS cost
      ${SALES_FROM}
      GROUP BY b.name, p.product_id, p.code, p.name, ty.name
      ORDER BY b.name, revenue DESC, p.code`, params)).rows;

    const sales = (await pool.query(`
      SELECT o.unique_code AS "orderCode", b.name AS branch, t.number AS "table", pa.paid_at AS "paidAt", pa.method,
             SUM(d.quantity)::int AS units,
             SUM(d.quantity * d.unit_price)::float AS revenue,
             SUM(d.quantity * d.unit_cost)::float AS cost
      ${SALES_FROM}
      GROUP BY o.order_id, o.unique_code, b.name, t.number, pa.paid_at, pa.method
      ORDER BY pa.paid_at, o.order_id`, params)).rows;

    // Profit per product line and per sale
    for (const x of byProduct) { x.profit = round2(x.revenue - x.cost); x.margin = marginPct(x.profit, x.revenue); }
    for (const x of sales) { x.profit = round2(x.revenue - x.cost); x.methodName = METHOD_NAMES[x.method] || x.method; }

    // Totals per branch and overall (summed in cents to avoid rounding errors)
    const branches = new Map();
    const total = { orders: sales.length, units: 0, revenueC: 0, costC: 0 };
    for (const s of sales) {
      const b = branches.get(s.branch) || { branch: s.branch, orders: 0, units: 0, revenueC: 0, costC: 0 };
      b.orders++; b.units += s.units; b.revenueC += cents(s.revenue); b.costC += cents(s.cost);
      branches.set(s.branch, b);
      total.units += s.units; total.revenueC += cents(s.revenue); total.costC += cents(s.cost);
    }
    const finish = (x) => {
      const revenue = x.revenueC / 100, cost = x.costC / 100, profit = (x.revenueC - x.costC) / 100;
      return { ...(x.branch ? { branch: x.branch } : {}), orders: x.orders, units: x.units, revenue, cost, profit, margin: marginPct(profit, revenue) };
    };

    return {
      filters: { from: f.from, to: f.to, branch: f.branch ? f.branch.name : 'All branches' },
      summary: finish(total),
      byBranch: [...branches.values()].map(finish).sort((a, b) => b.revenue - a.revenue),
      byProduct,
      sales
    };
  }

  app.get('/api/reports/sales', auth, adminOnly, wrap(async (req, res) => {
    const f = await readFilters(req.query);
    const report = await salesReport(f);
    await log(req.user.id, 'reports', `Viewed sales report ${f.from} to ${f.to} (${report.filters.branch})`);
    res.json(report);
  }));

  // ---------------------------------------------------------------------
  //  Excel export
  //  1) file structure (4 sheets)  2) report data  3) generate .xlsx
  //  4) validate: the totals written in every sheet must match the summary
  // ---------------------------------------------------------------------
  const MONEY_FMT = '"$"#,##0';
  const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C1A15' } };

  function addSheet(wb, name, columns, rows) {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 16, style: c.money ? { numFmt: MONEY_FMT } : {} }));
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFD4AF37' } };
    head.fill = HEADER_FILL;
    head.alignment = { vertical: 'middle' };
    rows.forEach((r) => ws.addRow(r));
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    return ws;
  }

  function addTotalRow(ws, values) {
    const row = ws.addRow(values);
    row.font = { bold: true };
    row.border = { top: { style: 'thin' } };
  }

  // Sums a money column of a sheet (data rows only) in cents
  function sheetSum(ws, key, lastDataRow) {
    let sum = 0;
    for (let i = 2; i <= lastDataRow; i++) sum += cents(ws.getRow(i).getCell(key).value || 0);
    return sum;
  }

  async function buildWorkbook(report, user) {
    const wb = new ExcelJS.Workbook();
    wb.creator = "Liar's Bar Management System";
    wb.created = new Date();
    const s = report.summary;

    // Sheet 1: Summary
    const ws1 = wb.addWorksheet('Summary');
    ws1.columns = [{ width: 26 }, { width: 30 }];
    ws1.addRow(["Liar's Bar — Sales report"]).font = { bold: true, size: 14 };
    [['Period', `${report.filters.from} to ${report.filters.to}`], ['Branch', report.filters.branch],
     ['Generated by', user.name], ['Generated at', new Date().toLocaleString('en-US')], []]
      .forEach((r) => ws1.addRow(r));
    const totals = [['Orders (sales)', s.orders], ['Units sold', s.units], ['Revenue', s.revenue], ['Cost', s.cost],
                    ['Profit', s.profit], ['Margin (%)', s.margin]];
    totals.forEach(([k, v]) => {
      const row = ws1.addRow([k, v]);
      row.getCell(1).font = { bold: true };
      if (['Revenue', 'Cost', 'Profit'].includes(k)) row.getCell(2).numFmt = MONEY_FMT;
    });

    const moneyCols = [
      { header: 'Revenue', key: 'revenue', money: true }, { header: 'Cost', key: 'cost', money: true },
      { header: 'Profit', key: 'profit', money: true }, { header: 'Margin (%)', key: 'margin', width: 12 }
    ];

    // Sheet 2: By branch
    const ws2 = addSheet(wb, 'By branch', [
      { header: 'Branch', key: 'branch', width: 22 }, { header: 'Orders', key: 'orders', width: 10 },
      { header: 'Units', key: 'units', width: 10 }, ...moneyCols], report.byBranch);
    const last2 = ws2.rowCount;
    addTotalRow(ws2, { branch: 'TOTAL', orders: s.orders, units: s.units, revenue: s.revenue, cost: s.cost, profit: s.profit, margin: s.margin });

    // Sheet 3: By product
    const ws3 = addSheet(wb, 'By product', [
      { header: 'Branch', key: 'branch', width: 18 }, { header: 'Code', key: 'code', width: 12 },
      { header: 'Product', key: 'product', width: 30 }, { header: 'Type', key: 'type', width: 14 },
      { header: 'Units', key: 'units', width: 10 }, ...moneyCols], report.byProduct);
    const last3 = ws3.rowCount;
    addTotalRow(ws3, { branch: 'TOTAL', units: s.units, revenue: s.revenue, cost: s.cost, profit: s.profit, margin: s.margin });

    // Sheet 4: Sales (one row per closed order)
    const ws4 = addSheet(wb, 'Sales', [
      { header: 'Order', key: 'orderCode', width: 24 }, { header: 'Branch', key: 'branch', width: 18 },
      { header: 'Table', key: 'table', width: 8 }, { header: 'Paid at', key: 'paidAt', width: 20 },
      { header: 'Method', key: 'methodName', width: 14 }, { header: 'Units', key: 'units', width: 8 },
      { header: 'Total', key: 'revenue', money: true }, { header: 'Cost', key: 'cost', money: true },
      { header: 'Profit', key: 'profit', money: true }],
      report.sales.map((x) => ({ ...x, paidAt: new Date(x.paidAt) })));
    ws4.getColumn('paidAt').numFmt = 'yyyy-mm-dd hh:mm';
    const last4 = ws4.rowCount;
    addTotalRow(ws4, { orderCode: 'TOTAL', units: s.units, revenue: s.revenue, cost: s.cost, profit: s.profit });

    // Validation of the exported information: every sheet must add up to the summary
    const expected = { revenue: cents(s.revenue), cost: cents(s.cost), profit: cents(s.profit) };
    for (const [ws, last] of [[ws2, last2], [ws3, last3], [ws4, last4]]) {
      for (const key of ['revenue', 'cost', 'profit']) {
        if (sheetSum(ws, key, last) !== expected[key]) {
          throw new HttpError(500, `Export validation failed: "${ws.name}" ${key} does not match the summary.`);
        }
      }
    }
    if (report.byProduct.reduce((a, x) => a + x.units, 0) !== s.units) {
      throw new HttpError(500, 'Export validation failed: units by product do not match the summary.');
    }
    return wb;
  }

  app.get('/api/reports/sales/export', auth, adminOnly, wrap(async (req, res) => {
    const f = await readFilters(req.query);
    const report = await salesReport(f);
    const wb = await buildWorkbook(report, req.user);
    const buffer = await wb.xlsx.writeBuffer();

    const file = `sales-report_${f.from}_${f.to}.xlsx`;
    await log(req.user.id, 'reports', `Exported sales report to Excel: ${f.from} to ${f.to} (${report.filters.branch})`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.send(Buffer.from(buffer));
  }));
};
