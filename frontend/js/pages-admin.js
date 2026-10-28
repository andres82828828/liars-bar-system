'use strict';
// =====================================================================
//  SALES REPORT + Excel export (Administrator: any branch · Cashier: own branch)
//  ADMINISTRATION (Administrator only): audit trail, users, branches and tables
// =====================================================================

// =====================================================================
//  SALES REPORT
// =====================================================================
async function pReport() {
    if (!S.report) S.report = { from: firstOfMonth(), to: isoDay(), branch: 'all', dateBy: 'order' };
    const f = S.report;
    const r = await api(`/reports/sales?${reportQuery(f)}`);
    // The Cashier only sees their own branch (the server enforces it too)
    const branchField = isAdmin()
        ? `<select id="repBranch"><option value="all">All branches</option>${optionsHTML(S.branches, f.branch)}</select>`
        : `<select id="repBranch" disabled><option value="">${esc(branchName())}</option></select>`;
    const filters = `<section class="card">
        <div class="filter-bar">
            <div class="field"><label>From</label><input type="date" id="repFrom" value="${f.from}" max="${isoDay()}"></div>
            <div class="field"><label>To</label><input type="date" id="repTo" value="${f.to}" max="${isoDay()}"></div>
            <div class="field"><label>Filter dates by</label><select id="repDateBy">
                <option value="order" ${f.dateBy !== 'payment' ? 'selected' : ''}>Order date (taken)</option>
                <option value="payment" ${f.dateBy === 'payment' ? 'selected' : ''}>Payment date</option></select></div>
            <div class="field"><label>Branch</label>${branchField}</div>
            <button class="btn" onclick="applyReportFilter()">Generate report</button>
            <button class="btn btn-ok" id="btnExport" onclick="exportReport()"><i class="fa-solid fa-file-excel"></i> Export to Excel</button>
        </div>
    </section>`;
    if (!r.ok) return filters + errCard(r.data.error);
    const rep = r.data, s = rep.summary;

    const stats = `<div class="stats">
        <div class="card stat"><div class="stat-ico y"><i class="fa-solid fa-receipt"></i></div><div><div class="stat-num">${s.orders}</div><div class="stat-lbl">Sales (closed orders) · ${s.units} units</div></div></div>
        <div class="card stat"><div class="stat-ico b"><i class="fa-solid fa-sack-dollar"></i></div><div><div class="stat-num" style="font-size:1.4rem">${money(s.revenue)}</div><div class="stat-lbl">Revenue</div></div></div>
        <div class="card stat"><div class="stat-ico r"><i class="fa-solid fa-arrow-trend-down"></i></div><div><div class="stat-num" style="font-size:1.4rem">${money(s.cost)}</div><div class="stat-lbl">Cost</div></div></div>
        <div class="card stat"><div class="stat-ico g"><i class="fa-solid fa-arrow-trend-up"></i></div><div><div class="stat-num" style="font-size:1.4rem">${money(s.profit)}</div><div class="stat-lbl">Profit · ${s.margin}% margin</div></div></div>
    </div>`;

    const branchRows = rep.byBranch.map(b => `<tr><td><b>${esc(b.branch)}</b></td><td class="num">${b.orders}</td><td class="num">${b.units}</td>
        <td class="num">${money(b.revenue)}</td><td class="num">${money(b.cost)}</td><td class="num"><b>${money(b.profit)}</b></td><td class="num">${b.margin}%</td></tr>`).join('');

    const productRowsHtml = rep.byProduct.map(p => `<tr class="rep-row" data-q="${esc((p.product + ' ' + p.code + ' ' + p.type + ' ' + p.branch).toLowerCase())}">
        <td>${esc(p.branch)}</td><td><b>${esc(p.product)}</b><br><small>${esc(p.code)} · ${esc(p.type)}</small></td>
        <td class="num">${p.units}</td><td class="num">${money(p.revenue)}</td><td class="num">${money(p.cost)}</td>
        <td class="num"><b class="${p.profit < 0 ? 'neg' : ''}">${money(p.profit)}</b></td><td class="num">${p.margin}%</td></tr>`).join('');

    const salesRowsHtml = rep.sales.map(x => `<tr class="sale-row" data-q="${esc((x.orderCode + ' ' + x.branch + ' ' + x.methodName).toLowerCase())}">
        <td><b>${esc(x.orderCode)}</b><br><small>${esc(x.branch)} · Table #${x.table}</small></td>
        <td>${fmtDate(x.takenAt)}</td><td>${fmtDate(x.paidAt)}</td><td>${esc(x.methodName)}</td>
        <td class="num">${x.units}</td><td class="num"><b>${money(x.revenue)}</b></td><td class="num">${money(x.cost)}</td>
        <td class="num">${money(x.profit)}</td></tr>`).join('');

    const empty = `<div class="empty"><span class="big"><i class="fa-solid fa-chart-line"></i></span>No sales between ${esc(rep.filters.from)} and ${esc(rep.filters.to)}.<br><small>Only paid (closed) orders count as sales: open orders appear here once they are charged.</small></div>`;
    const totalRow = (cols) => `<tr class="total-row"><td${cols > 1 ? ` colspan="${cols}"` : ''}>TOTAL</td>`;

    return filters + stats + `
    <section class="card">
        <div class="card-head"><h3>By branch</h3><small>${esc(rep.filters.branch)} · ${esc(rep.filters.from)} to ${esc(rep.filters.to)}</small></div>
        ${rep.byBranch.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Branch</th><th class="num">Sales</th><th class="num">Units</th><th class="num">Revenue</th><th class="num">Cost</th><th class="num">Profit</th><th class="num">Margin</th></tr></thead>
            <tbody>${branchRows}${totalRow(1)}<td class="num">${s.orders}</td><td class="num">${s.units}</td><td class="num">${money(s.revenue)}</td><td class="num">${money(s.cost)}</td><td class="num">${money(s.profit)}</td><td class="num">${s.margin}%</td></tr></tbody></table></div>` : empty}
    </section>
    <section class="card">
        <div class="card-head"><h3>By product</h3>
            <input class="search" placeholder="Search product…" oninput="filterRows(this.value,'.rep-row')"></div>
        ${rep.byProduct.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Branch</th><th>Product</th><th class="num">Units</th><th class="num">Revenue</th><th class="num">Cost</th><th class="num">Profit</th><th class="num">Margin</th></tr></thead>
            <tbody>${productRowsHtml}${totalRow(2)}<td class="num">${s.units}</td><td class="num">${money(s.revenue)}</td><td class="num">${money(s.cost)}</td><td class="num">${money(s.profit)}</td><td class="num">${s.margin}%</td></tr></tbody></table></div>` : empty}
    </section>
    <section class="card">
        <div class="card-head"><h3>Sales</h3><small>One row per paid order · dates by ${esc(rep.filters.dateByLabel.toLowerCase())}</small>
            <input class="search" placeholder="Search order…" oninput="filterRows(this.value,'.sale-row')"></div>
        ${rep.sales.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Order</th><th>Taken</th><th>Paid</th><th>Method</th><th class="num">Units</th><th class="num">Total</th><th class="num">Cost</th><th class="num">Profit</th></tr></thead>
            <tbody>${salesRowsHtml}${totalRow(4)}<td class="num">${s.units}</td><td class="num">${money(s.revenue)}</td><td class="num">${money(s.cost)}</td><td class="num">${money(s.profit)}</td></tr></tbody></table></div>` : empty}
    </section>`;
}

const reportQuery = (f) => `from=${f.from}&to=${f.to}&branch_id=${f.branch}&date_by=${f.dateBy}`;

function readReportFilter() {
    const from = $('#repFrom').value, to = $('#repTo').value, dateBy = $('#repDateBy').value;
    const branch = isAdmin() ? ($('#repBranch').value || 'all') : String(S.branchId || '');
    if (!from || !to) { toast('Select both dates.', 'warn'); return null; }
    if (from > to) { toast('The start date cannot be after the end date.', 'warn'); return null; }
    return { from, to, branch, dateBy };
}

function applyReportFilter() {
    const f = readReportFilter();
    if (!f) return;
    S.report = f;
    go('report');
}

// Downloads the .xlsx generated (and validated) by the server with the current filters
async function exportReport() {
    const f = readReportFilter();
    if (!f) return;
    S.report = f;
    const btn = $('#btnExport'); btn.disabled = true; btn.textContent = 'Generating…';
    const r = await apiDownload(`/reports/sales/export?${reportQuery(f)}`, `sales-report_${f.from}_${f.to}.xlsx`);
    btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-file-excel"></i> Export to Excel';
    if (!r.ok) { toast(r.error, 'err'); return; }
    toast(`Excel file downloaded: ${r.name}`);
}

// =====================================================================
//  AUDIT TRAIL
// =====================================================================
async function pAudit() {
    if (!S.audit) S.audit = { from: isoDay(new Date(Date.now() - 6 * 86400000)), to: isoDay(), userId: '', category: '', q: '' };
    const f = S.audit;
    const qs = new URLSearchParams({ from: f.from, to: f.to, user_id: f.userId, category: f.category, q: f.q }).toString();
    const [r, ru, rc] = await Promise.all([api('/audit-log?' + qs), api('/users'), api('/audit-log/categories')]);
    const users = ru.ok ? ru.data : [];
    const categories = rc.ok ? rc.data : [];

    const userOpts = users.map(u => `<option value="${u.id}" ${String(u.id) === String(f.userId) ? 'selected' : ''}>${esc(u.username)} — ${esc(u.name)}</option>`).join('');
    const catOpts = categories.map(c => `<option value="${c.id}" ${c.id === f.category ? 'selected' : ''} title="${esc(c.description)}">${esc(c.id)}</option>`).join('');

    const filters = `<section class="card">
        <div class="filter-bar">
            <div class="field"><label>From</label><input type="date" id="audFrom" value="${f.from}" max="${isoDay()}"></div>
            <div class="field"><label>To</label><input type="date" id="audTo" value="${f.to}" max="${isoDay()}"></div>
            <div class="field"><label>User</label><select id="audUser"><option value="">All users</option>${userOpts}</select></div>
            <div class="field"><label>Category</label><select id="audCat"><option value="">All categories</option>${catOpts}</select></div>
            <div class="field grow"><label>Text</label><input id="audQ" value="${esc(f.q)}" placeholder="e.g. payment, ORD-…" maxlength="100"
                onkeydown="if(event.key==='Enter')applyAuditFilter()"></div>
            <button class="btn" onclick="applyAuditFilter()">Search</button>
        </div>
        <details class="audit-help"><summary>Which operations are recorded?</summary>
            <ul>${categories.map(c => `<li><span class="badge cat">${esc(c.id)}</span> ${esc(c.description)}</li>`).join('')}</ul>
            <p class="hint">Each record stores the user, the date and time, and the operation. Only the Administrator can view the trail; denied access attempts are recorded too.</p>
        </details>
    </section>`;
    if (!r.ok) return filters + errCard(r.data.error);

    const rows = r.data.rows.map(x => `<tr>
        <td class="nowrap">${fmtDate(x.createdAt)}</td>
        <td><b>${esc(x.username)}</b><br><small>${esc(x.name)} · ${esc(x.role)}</small></td>
        <td><span class="badge cat ${x.category === 'security' ? 'bad' : ''}">${esc(x.category)}</span></td>
        <td>${esc(x.operation)}</td></tr>`).join('');

    return filters + `<section class="card">
        <div class="card-head"><h3>Records</h3><small>Showing ${r.data.shown} of ${r.data.total}${r.data.total > r.data.shown ? ` (latest ${r.data.limit}; narrow the filters)` : ''}</small></div>
        ${r.data.rows.length
            ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Date and time</th><th>User</th><th>Category</th><th>Operation</th></tr></thead><tbody>${rows}</tbody></table></div>`
            : `<div class="empty"><span class="big"><i class="fa-solid fa-user-secret"></i></span>No records match the filters.</div>`}
    </section>`;
}

function applyAuditFilter() {
    const from = $('#audFrom').value, to = $('#audTo').value;
    if (from && to && from > to) { toast('The start date cannot be after the end date.', 'warn'); return; }
    S.audit = { from, to, userId: $('#audUser').value, category: $('#audCat').value, q: $('#audQ').value.trim() };
    go('audit');
}

// =====================================================================
//  USERS
// =====================================================================
async function pUsers() {
    const r = await api('/users');
    if (!r.ok) return errCard(r.data.error);
    S.users = r.data;

    const form = `<section class="card">
        <div class="card-head"><h3>Register user</h3></div>
        <div class="field"><label>Full name *</label><input id="newName" placeholder="e.g. Ana Gómez" maxlength="100"></div>
        <div class="row2">
            <div class="field"><label>Username (login) *</label><input id="newUsername" placeholder="e.g. agomez" autocomplete="off" maxlength="50"></div>
            <div class="field"><label>Password *</label><input type="password" id="newPass" placeholder="Password" autocomplete="new-password" maxlength="64"></div>
        </div>
        <span class="hint" style="margin:-8px 0 12px">Username: 3 to 50 characters, no spaces or accents. Password: 8 to 64 characters, one uppercase letter, one number, no spaces and not containing the username.</span>
        <div class="row2">
            <div class="field"><label>Role *</label>
                <select id="newRole" onchange="roleChange()"><option>Cashier</option><option>Waiter</option><option>Administrator</option></select></div>
            <div class="field"><label>Assigned branch *</label><select id="newBranch">${optionsHTML(S.branches, S.branchId)}</select></div>
        </div>
        <button class="btn btn-block" onclick="createUser()">Save user</button>
    </section>`;

    const rows = r.data.map(u => {
        let status = !u.active ? '<span class="badge warn">Deactivated</span>' : (u.locked ? '<span class="badge locked">Locked</span>' : '<span class="badge active">Active</span>');
        if (u.resetAuthorized) status += ' <span class="badge warn" title="Can change their password from the login screen">Change authorized</span>';
        const actions = !u.active
            ? `<button class="btn btn-sm btn-ok" onclick="setUserStatus(${u.id},true)">Activate</button>`
            : (u.locked ? `<button class="btn btn-sm btn-ok" onclick="setUserStatus(${u.id},true)">Unlock</button> ` : '')
              + `<button class="btn btn-sm btn-danger" onclick="setUserStatus(${u.id},false)">Deactivate</button>`
              + (u.id !== S.user.id
                  ? (u.resetAuthorized
                      ? ` <button class="btn btn-sm btn-ghost" title="Cancel the authorization" onclick="authorizePasswordChange(${u.id},false)">Cancel change</button>`
                      : ` <button class="btn btn-sm btn-ghost" title="Allow the user to change their password" onclick="authorizePasswordChange(${u.id},true)"><i class="fa-solid fa-key"></i> Reset password</button>`)
                  : '');
        return `<tr><td><b>${esc(u.username)}</b><br><small>${esc(u.name)}</small></td><td>${esc(u.role)}<br><small>${esc(u.branch || 'All branches')}</small></td>
            <td>${status}</td><td class="act">${actions}</td></tr>`;
    }).join('');

    const table = `<section class="card"><div class="card-head"><h3>List and activation</h3><small>${r.data.length} user(s)</small></div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>User</th><th>Role / Branch</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;

    return `<div class="split" style="grid-template-columns:minmax(0,1fr) minmax(0,1.4fr)">${form}${table}</div>`;
}

function roleChange() { $('#newBranch').disabled = $('#newRole').value === ROLE.ADMIN; }

// User registration validation (same rules as the server). Returns [message, field] or null.
const NAME_RE = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' .-]+$/;
const USERNAME_RE = /^[A-Za-z0-9._-]+$/;

function userError({ fullName, username, password, role, branchId }) {
    if (!fullName) return ['Please fill in all required fields.', 'newName'];
    if (!username) return ['Please fill in all required fields.', 'newUsername'];
    if (!password) return ['Please fill in all required fields.', 'newPass'];
    if (fullName.length < 3 || fullName.length > 100) return ['The full name must be between 3 and 100 characters.', 'newName'];
    if (!NAME_RE.test(fullName)) return ['The full name can only contain letters, spaces, periods, hyphens and apostrophes.', 'newName'];
    if (username.length < 3 || username.length > 50) return ['The username must be between 3 and 50 characters.', 'newUsername'];
    if (!USERNAME_RE.test(username)) return ['The username can only contain letters without accents, numbers, period, hyphen or underscore (no spaces).', 'newUsername'];
    if (S.users.some(u => u.username.toLowerCase() === username.toLowerCase())) return ['The username already exists in the system.', 'newUsername'];
    const ep = passwordError(password);
    if (ep) return [ep, 'newPass'];
    if (password.toLowerCase().includes(username.toLowerCase())) return ['The password cannot contain the username.', 'newPass'];
    if (role !== ROLE.ADMIN && !branchId) return [S.branches.length ? 'Select a branch for this role.' : 'There are no branches: create one in Branches & tables before registering cashiers or waiters.', 'newBranch'];
    return null;
}

async function createUser() {
    const fullName = $('#newName').value.trim().replace(/\s+/g, ' '), username = $('#newUsername').value.trim();
    const password = $('#newPass').value, role = $('#newRole').value, branchId = $('#newBranch').value;
    const err = userError({ fullName, username, password, role, branchId });
    if (err) {
        toast(err[0], 'warn');
        const field = $('#' + err[1]);
        if (field) { field.classList.add('invalid'); field.focus(); field.addEventListener('input', () => field.classList.remove('invalid'), { once: true }); }
        return;
    }
    const { ok, data } = await api('/users', 'POST', { fullName, username, password, role, branchId });
    if (!ok) { toast(data.error || 'The user could not be created.', 'err'); return; }
    toast(`User ${fullName} (${role}) created successfully.`);
    go('users');
}

// The admin authorizes (or cancels) that the user changes their own password from the login screen
async function authorizePasswordChange(id, authorize) {
    const { ok, data } = await api(`/users/${id}/reset`, authorize ? 'PUT' : 'DELETE');
    if (!ok) { toast(data.error || 'The authorization could not be updated.', 'err'); return; }
    toast(authorize
        ? `Change authorized. The user has ${data.minutes} minutes to go to "Forgot password?" and choose a new password.`
        : 'Authorization cancelled.');
    go('users');
}

async function setUserStatus(id, active) {
    const { ok, data } = await api(`/users/${id}/status`, 'PATCH', { active });
    if (!ok) { toast(data.error || 'The status could not be changed.', 'err'); return; }
    toast(`User ${active ? 'activated' : 'deactivated'} successfully.`);
    go('users');
}

// =====================================================================
//  BRANCHES AND TABLES
// =====================================================================
async function pBranches() {
    const r = await api('/branches');
    if (r.ok) S.branches = r.data;

    const branchForm = `<section class="card"><div class="card-head"><h3>Create branch</h3></div>
        <div class="field"><label>Branch name *</label><input id="branchName" placeholder="e.g. North Branch" maxlength="50"></div>
        <div class="field"><label>Address *</label><input id="branchAddress" placeholder="e.g. Calle 85 # 12-45" maxlength="100"></div>
        <button class="btn btn-block" onclick="createBranch()">Register branch</button></section>`;

    const tableForm = `<section class="card"><div class="card-head"><h3>Create table per branch</h3></div>
        <div class="field"><label>Branch *</label><select id="tableBranch">${optionsHTML(S.branches, S.branchId, 'Select branch…')}</select></div>
        <div class="field"><label>Table number *</label><input type="number" id="tableNumber" min="1" max="9999" placeholder="e.g. 4"></div>
        <button class="btn btn-block" onclick="createTable()">Add table</button></section>`;

    const list = `<section class="card"><div class="card-head"><h3>Registered branches</h3><small>${S.branches.length} branch(es)</small></div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Branch</th><th>Address</th></tr></thead><tbody>
        ${S.branches.map(b => `<tr><td><b>${esc(b.name)}</b></td><td>${esc(b.address)}</td></tr>`).join('')}</tbody></table></div></section>`;

    return `<div class="split even"><div class="stack">${branchForm}${tableForm}</div>${list}</div>`;
}

async function createBranch() {
    const name = $('#branchName').value.trim(), address = $('#branchAddress').value.trim();
    if (!name || !address) { toast('Please fill in all branch fields.', 'warn'); return; }
    const { ok, data } = await api('/branches', 'POST', { name, address });
    if (!ok) { toast(data.error || 'The branch could not be created.', 'err'); return; }
    toast(`Branch "${name}" registered successfully.`);
    if (!S.branchId) S.branchId = data.id;
    go('branches');
}

async function createTable() {
    const branchId = $('#tableBranch').value, number = $('#tableNumber').value.trim();
    if (!branchId || !number) { toast('Select a branch and enter the table number.', 'warn'); return; }
    const { ok, data } = await api('/tables', 'POST', { branchId: Number(branchId), number: Number(number) });
    if (!ok) { toast(data.error || 'The table could not be created.', 'err'); return; }
    toast(`Table #${number} created successfully.`);
    $('#tableNumber').value = '';
}
