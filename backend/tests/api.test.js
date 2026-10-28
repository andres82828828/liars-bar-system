// API tests (run them with: npm test). They use a temporary database, never liars_bar.

const ExcelJS = require('exceljs');
const BASE = `http://localhost:${process.env.TEST_PORT || 3999}/api`;
let pass = 0, fail = 0;

async function call(token, p, method = 'GET', body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✖', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
}
async function login(u, p) {
  const r = await call(null, '/login', 'POST', { username: u, password: p, force: true });
  if (r.status !== 200) throw new Error('login ' + u + ' ' + JSON.stringify(r.data));
  return r.data;
}
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const tomorrow = () => { const d = new Date(Date.now() + 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

(async () => {
  const A = await login('cmendoza', 'Admin123*');     // Administrator
  const C = await login('aperez', 'Cajero123*');      // Cashier, branch 1 Zona T
  const W = await login('lgarcia', 'Mesero123*');     // Waiter, branch 2 Modelia
  const admin = A.token, cashier = C.token, waiter = W.token;
  check('roles in English', A.user.role === 'Administrator' && C.user.role === 'Cashier' && W.user.role === 'Waiter', [A.user, C.user, W.user]);

  console.log('\n1) Previous fixes still work (English API)');
  let r = await call(admin, '/products', 'POST', { code: 'TST-1', name: 'Test', typeId: 1, supplierId: 1, purchasePrice: 10000, salePrice: 9000 });
  check(`sale < purchase rejected → "${r.data.error}"`, r.status === 400, r);
  r = await call(admin, '/users', 'POST', { fullName: 'A'.repeat(101), username: 'x1', password: 'Clave1234', role: 'Cashier', branchId: 1 });
  check('invalid user rejected with 400', r.status === 400, r);
  r = await call(admin, '/users', 'POST', { fullName: 'Ana Gómez', username: 'APEREZ', password: 'Clave1234', role: 'Cashier', branchId: 1 });
  check('duplicate username (case-insensitive) → 409', r.status === 409, r);
  r = await call(admin, '/inventory/availability', 'PATCH', { branchId: 1, productId: 3, active: false });
  check('admin deactivates Mojito in Zona T', r.status === 200, r);
  r = await call(cashier, '/catalog');
  check('inactive product leaves the catalog', !r.data.some(x => x.id === 3), r.data);
  await call(admin, '/inventory/availability', 'PATCH', { branchId: 1, productId: 3, active: true });

  console.log('\n2) HU-030 Administrator does WAITER work');
  r = await call(admin, '/tables?branch_id=1');
  check('admin lists tables of Zona T', r.status === 200 && r.data.length === 2, r.data);
  const freeTable = r.data.find(t => t.status === 'free');
  r = await call(admin, '/orders', 'POST', { tableId: freeTable.id });
  check('admin selects a free table and creates an order', r.status === 201, r);
  const adminOrder = r.data.id;
  r = await call(admin, `/orders/${adminOrder}/items`, 'POST', { productId: 1, quantity: 2 });   // Aguardiente 55000 (cost 28000)
  check('admin adds products and quantities', r.status === 201 && r.data.total === 110000, r.data.total);
  r = await call(admin, `/orders/${adminOrder}/items`, 'POST', { productId: 3, quantity: 1 });   // Mojito 24000 (cost 6000)
  check('admin modifies the open order (adds another product)', r.status === 201 && r.data.total === 134000, r.data.total);
  r = await call(admin, `/orders/${adminOrder}/items`, 'POST', { productId: 1, quantity: 999 });
  check('admin is limited to available quantities', r.status === 409, r);
  r = await call(admin, '/tables?branch_id=1');
  check('table is now occupied', r.data.find(t => t.id === freeTable.id).status === 'occupied', r.data);

  console.log('\n3) HU-030 Administrator does CASHIER work');
  r = await call(admin, '/orders?branch_id=all&status=open');
  check('admin sees open orders of ALL branches', r.status === 200 && r.data.some(o => o.id === adminOrder) && r.data.every(o => o.branch), r.data);
  r = await call(cashier, '/orders?branch_id=all&status=open');
  check('cashier asking for all branches only gets their own', r.data.every(o => o.branch === 'Zona T'), r.data);
  r = await call(admin, `/orders/${adminOrder}/payment`, 'POST', { method: 'cash', amountReceived: 100000 });
  check('insufficient cash rejected', r.status === 400 && /missing/.test(r.data.error), r);
  r = await call(admin, `/orders/${adminOrder}/payment`, 'POST', { method: 'credit_card', amountReceived: 134000 });
  check('admin registers payment by credit card', r.status === 201 && r.data.change === 0 && r.data.invoiceNumber, r);
  const adminInvoice = r.data.invoiceId;

  console.log('\n4) Close order and release table');
  r = await call(admin, `/orders/${adminOrder}`);
  check('order status changed to "closed" with closedAt', r.data.status === 'closed' && r.data.closedAt, r.data);
  check('order has payment and invoice', r.data.payment && r.data.payment.cashier === 'Carlos Mendoza' && r.data.invoice && r.data.invoice.id === adminInvoice, r.data);
  r = await call(admin, '/tables?branch_id=1');
  check('table released (free)', r.data.find(t => t.id === freeTable.id).status === 'free', r.data);
  r = await call(admin, `/orders/${adminOrder}/items`, 'POST', { productId: 2, quantity: 1 });
  check('no products can be added after closing (409)', r.status === 409 && /closed/.test(r.data.error), r);
  r = await call(admin, `/orders/${adminOrder}/cancel`, 'POST');
  check('a closed order cannot be cancelled (409)', r.status === 409, r);
  r = await call(admin, `/orders/${adminOrder}/payment`, 'POST', { method: 'cash', amountReceived: 200000 });
  check('a closed order cannot be paid again (409)', r.status === 409, r);

  console.log('\n5) Cashier pays the sample order in cash → invoice');
  r = await call(cashier, '/orders/1');
  check('sample order total 70000', r.data.total === 70000, r.data.total);
  r = await call(waiter, '/orders/1/payment', 'POST', { method: 'cash', amountReceived: 100000 });
  check('waiter cannot charge (403)', r.status === 403, r);
  r = await call(cashier, '/orders/1/payment', 'POST', { method: 'cash', amountReceived: 100000 });
  check('cashier pays cash 100000 → change 30000', r.status === 201 && r.data.change === 30000, r);
  const cashInvoice = r.data.invoiceId;

  console.log('\n6) Invoice');
  r = await call(cashier, `/invoices/${cashInvoice}`);
  const inv = r.data;
  check('invoice number format INV-000002', r.status === 200 && /^INV-\d{6}$/.test(inv.number), inv.number);
  check('invoice has order info (code, table, dates)', inv.order && inv.order.code === 'ORD-SAMPLE-0001' && inv.order.table === 2 && inv.order.closedAt, inv.order);
  check('invoice has branch and business data', inv.branch.name === 'Zona T' && inv.branch.address && inv.business.name === "Liar's Bar", inv.branch);
  check('invoice shows products and quantities', inv.items.length === 2 && inv.items.some(i => i.name === 'Club Colombia Beer' && i.quantity === 4 && i.subtotal === 48000), inv.items);
  check('invoice shows total and payment method', inv.total === 70000 && inv.payment.method === 'cash' && inv.payment.amountReceived === 100000 && inv.payment.change === 30000 && inv.payment.cashier === 'Andrés Pérez', inv.payment);
  check('sum of invoice lines = total', inv.items.reduce((a, i) => a + i.subtotal, 0) === inv.total, inv.items);
  r = await call(waiter, `/invoices/${cashInvoice}`);
  check('waiter cannot open invoices (403)', r.status === 403, r);
  r = await call(cashier, `/invoices/${adminInvoice}`);
  check('cashier opens invoice of own branch', r.status === 200, r);
  r = await call(cashier, `/orders/1/invoice`, 'POST');
  check('generate invoice again is idempotent (returns the same, 200)', r.status === 200 && r.data.created === false && r.data.id === cashInvoice, r);
  r = await call(cashier, '/invoices');
  check('invoice list of the branch has both invoices', r.status === 200 && r.data.length === 2 && r.data.every(x => x.number && x.total > 0), r.data);
  r = await call(admin, '/orders', 'POST', { tableId: 3 });   // Modelia table
  const openModelia = r.data.id;
  r = await call(admin, `/orders/${openModelia}/invoice`, 'POST');
  check('an open order cannot be invoiced (409)', r.status === 409, r);

  console.log('\n7) Sales report');
  // Expected: admin order 2x55000 + 1x24000 (cost 2x28000 + 6000) ; sample: 4x12000 + 1x22000 (cost 4x3500 + 7000)
  const expRevenue = 134000 + 70000, expCost = 62000 + 21000;
  r = await call(admin, `/reports/sales?from=${today()}&to=${today()}`);
  const rep = r.data;
  check('report summary orders = 2', r.status === 200 && rep.summary.orders === 2, rep.summary);
  check(`revenue ${expRevenue}, cost ${expCost}, profit ${expRevenue - expCost}`, rep.summary.revenue === expRevenue && rep.summary.cost === expCost && rep.summary.profit === expRevenue - expCost, rep.summary);
  check('margin %', rep.summary.margin === Math.round((expRevenue - expCost) / expRevenue * 1000) / 10, rep.summary.margin);
  check('by product shows product info and branch', rep.byProduct.length === 4 && rep.byProduct.every(p => p.branch === 'Zona T' && p.code && p.type && p.units > 0), rep.byProduct);
  const agu = rep.byProduct.find(p => p.code === 'LIC-001');
  check('profit per product (Aguardiente 110000 - 56000 = 54000)', agu && agu.profit === 54000, agu);
  check('by branch total equals summary', rep.byBranch.length === 1 && rep.byBranch[0].revenue === expRevenue, rep.byBranch);
  r = await call(admin, `/reports/sales?from=${tomorrow()}&to=${tomorrow()}`);
  check('date filter excludes sales outside the range', r.data.summary.orders === 0, r.data.summary);
  r = await call(admin, `/reports/sales?from=${today()}&to=${today()}&branch_id=2`);
  check('branch filter (Modelia has no sales)', r.data.summary.orders === 0 && r.data.filters.branch === 'Modelia', r.data);
  r = await call(admin, '/reports/sales?from=2026-13-40');
  check('invalid date → 400', r.status === 400, r);
  r = await call(admin, `/reports/sales?from=${tomorrow()}&to=${today()}`);
  check('from > to → 400', r.status === 400, r);
  r = await call(cashier, '/reports/sales');
  check('cashier cannot see the sales report (403)', r.status === 403, r);

  console.log('\n8) Excel export');
  const res = await fetch(`${BASE}/reports/sales/export?from=${today()}&to=${today()}`, { headers: { Authorization: 'Bearer ' + admin } });
  check('export responds 200 with xlsx content type', res.status === 200 && /spreadsheetml/.test(res.headers.get('content-type')), res.status);
  check('file name in Content-Disposition', /sales-report_.*\.xlsx/.test(res.headers.get('content-disposition') || ''), res.headers.get('content-disposition'));
  const buf = Buffer.from(await res.arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  check('workbook has 4 sheets', wb.worksheets.map(w => w.name).join('|') === 'Summary|By branch|By product|Sales', wb.worksheets.map(w => w.name));
  const sum = wb.getWorksheet('Summary');
  const findVal = (label) => { let v; sum.eachRow(row => { if (row.getCell(1).value === label) v = row.getCell(2).value; }); return v; };
  check('Summary sheet: revenue / cost / profit match the API', findVal('Revenue') === expRevenue && findVal('Cost') === expCost && findVal('Profit') === expRevenue - expCost,
    [findVal('Revenue'), findVal('Cost'), findVal('Profit')]);
  const byProd = wb.getWorksheet('By product');
  let revSum = 0, units = 0;
  byProd.eachRow((row, n) => { if (n > 1 && row.getCell(1).value !== 'TOTAL') { revSum += row.getCell(6).value; units += row.getCell(5).value; } });
  check('By product sheet rows add up to the summary', revSum === expRevenue && units === rep.summary.units, [revSum, units]);
  const sales = wb.getWorksheet('Sales');
  check('Sales sheet has one row per order + header + total', sales.rowCount === 1 + 2 + 1, sales.rowCount);
  const res2 = await fetch(`${BASE}/reports/sales/export`, { headers: { Authorization: 'Bearer ' + cashier } });
  check('cashier cannot export (403)', res2.status === 403, res2.status);

  console.log('\n9) Audit trail');
  r = await call(admin, '/audit-log/categories');
  check('categories of traceable operations defined', r.status === 200 && ['auth', 'orders', 'payments', 'invoices', 'reports', 'security'].every(c => r.data.some(x => x.id === c)), r.data);
  r = await call(admin, `/audit-log?from=${today()}&to=${today()}`);
  check('records have user, date-time, category and operation', r.status === 200 && r.data.rows.length > 10 &&
    r.data.rows.every(x => x.username && x.createdAt && x.category && x.operation), r.data.rows.slice(0, 2));
  r = await call(admin, '/audit-log?category=payments');
  check('payments recorded (2)', r.data.total === 2 && r.data.rows.every(x => x.category === 'payments'), r.data.rows);
  r = await call(admin, '/audit-log?category=invoices&q=INV-');
  check('invoice generation recorded', r.data.total === 2, r.data.rows);
  r = await call(admin, `/audit-log?user_id=${C.user.id}`);
  check('filter by user', r.data.rows.length > 0 && r.data.rows.every(x => x.userId === C.user.id), r.data.rows.slice(0, 2));
  r = await call(admin, '/audit-log?category=security');
  check('denied access attempts are recorded (security)', r.data.total >= 4 && r.data.rows.some(x => /Access denied/.test(x.operation)), r.data.rows);
  r = await call(cashier, '/audit-log');
  check('cashier cannot query the audit trail (403)', r.status === 403, r);
  r = await call(waiter, '/audit-log');
  check('waiter cannot query the audit trail (403)', r.status === 403, r);
  r = await call(admin, '/audit-log?user_id=abc');
  check('invalid filter → 400', r.status === 400, r);

  console.log('\n10) Administrator keeps management permissions');
  r = await call(admin, '/product-types', 'POST', { name: 'Desserts' });
  check('creates product type', r.status === 201, r);
  r = await call(admin, '/products', 'POST', { code: 'DES-001', name: 'Brownie', typeId: r.data.id, supplierId: 1, purchasePrice: 4000, salePrice: 9000 });
  check('creates product', r.status === 201, r);
  r = await call(admin, '/users', 'POST', { fullName: 'Ana Gómez', username: 'agomez', password: 'Clave1234', role: 'Waiter', branchId: 1 });
  check('creates user', r.status === 201, r);
  r = await call(admin, '/branches', 'POST', { name: 'Usaquén', address: 'Cl. 119 # 6-20' });
  check('creates branch', r.status === 201, r);
  r = await call(admin, '/tables', 'POST', { branchId: r.data.id, number: 1 });
  check('creates table', r.status === 201, r);
  r = await call(admin, '/inventory', 'POST', { branchId: 2, productId: 2, quantity: 10 });
  check('adds stock in any branch', r.status === 201, r);
  r = await call(waiter, '/products', 'POST', { code: 'X', name: 'X', typeId: 1, supplierId: 1, purchasePrice: 1, salePrice: 2 });
  check('waiter still cannot manage products (403)', r.status === 403, r);
  r = await call(waiter, '/orders', 'POST', { tableId: 4 });    // Modelia table 2
  check('waiter still does waiter work in own branch', r.status === 201, r);
  r = await call(waiter, '/orders', 'POST', { tableId: 1 });    // Zona T
  check('waiter cannot use another branch table (403)', r.status === 403, r);

  console.log(`\nResult: ${pass} OK, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
