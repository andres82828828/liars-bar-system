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

    const productRowsHtml = rep.byProduct.map(p => `<tr class="rep-row" data-q="${esc((p.product + ' ' + p.code + ' ' + p.type + ' ' + p.branch + ' ' + p.day).toLowerCase())}">
        <td>${esc(p.day)}</td><td>${esc(p.branch)}</td><td><b>${esc(p.product)}</b><br><small>${esc(p.code)} · ${esc(p.type)}</small></td>
        <td class="num">${money(p.unitCost)}</td><td class="num">${money(p.unitPrice)}</td>
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
        ${rep.byProduct.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Branch</th><th>Product</th><th class="num">Purchase value</th><th class="num">Sale value</th><th class="num">Units</th><th class="num">Revenue</th><th class="num">Cost</th><th class="num">Profit</th><th class="num">Margin</th></tr></thead>
            <tbody>${productRowsHtml}${totalRow(5)}<td class="num">${s.units}</td><td class="num">${money(s.revenue)}</td><td class="num">${money(s.cost)}</td><td class="num">${money(s.profit)}</td><td class="num">${s.margin}%</td></tr></tbody></table></div>` : empty}
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
    const activeBranches = S.branches.filter(b => b.active !== false);

    // Edit mode (RF-01): name, role and branch. The username and the password are not edited here.
    const editing = S.editUser ? S.users.find(u => u.id === S.editUser) : null;
    const roleOptions = (sel) => [ROLE.CASHIER, ROLE.WAITER, ROLE.ADMIN].map(x => `<option ${x === sel ? 'selected' : ''}>${x}</option>`).join('');
    const editForm = editing && `<section class="card">
        <div class="card-head"><h3>Edit user</h3><small>${esc(editing.username)}</small></div>
        <div class="field"><label>Full name *</label><input id="newName" value="${esc(editing.name)}" maxlength="100"></div>
        <div class="row2">
            <div class="field"><label>Role *</label>
                <select id="newRole" onchange="roleChange()" ${editing.id === S.user.id ? 'disabled title="You cannot change your own role"' : ''}>${roleOptions(editing.role)}</select></div>
            <div class="field"><label>Assigned branch *</label><select id="newBranch" ${editing.role === ROLE.ADMIN ? 'disabled' : ''}>${optionsHTML(activeBranches, editing.branchId || S.branchId)}</select></div>
        </div>
        <span class="hint" style="margin:-8px 0 12px">If the role or the branch changes, the user's open session is closed so the new permissions apply.</span>
        <div class="btn-row">
            <button class="btn" onclick="saveUserEdit(${editing.id})">Save changes</button>
            <button class="btn btn-ghost" onclick="S.editUser=null;go('users')">Cancel edit</button>
        </div>
    </section>`;

    const form = editForm || `<section class="card">
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
            <div class="field"><label>Assigned branch *</label><select id="newBranch">${optionsHTML(activeBranches, S.branchId)}</select></div>
        </div>
        <button class="btn btn-block" onclick="createUser()">Save user</button>
    </section>`;

    const rows = r.data.map(u => {
        let status = !u.active ? '<span class="badge warn">Deactivated</span>' : (u.locked ? '<span class="badge locked">Locked</span>' : '<span class="badge active">Active</span>');
        if (u.resetAuthorized) status += ' <span class="badge warn" title="Can change their password from the login screen">Change authorized</span>';
        const actions = `<button class="btn btn-sm btn-ghost" onclick="S.editUser=${u.id};go('users')">Edit</button> ` + (!u.active
            ? `<button class="btn btn-sm btn-ok" onclick="setUserStatus(${u.id},true)">Activate</button>`
            : (u.locked ? `<button class="btn btn-sm btn-ok" onclick="setUserStatus(${u.id},true)">Unlock</button> ` : '')
              + `<button class="btn btn-sm btn-danger" onclick="setUserStatus(${u.id},false)">Deactivate</button>`
              + (u.id !== S.user.id
                  ? (u.resetAuthorized
                      ? ` <button class="btn btn-sm btn-ghost" title="Cancel the authorization" onclick="authorizePasswordChange(${u.id},false)">Cancel change</button>`
                      : ` <button class="btn btn-sm btn-ghost" title="Allow the user to change their password" onclick="authorizePasswordChange(${u.id},true)"><i class="fa-solid fa-key"></i> Reset password</button>`)
                  : ''));
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

// Saves the edited name, role and branch (RF-01)
async function saveUserEdit(id) {
    const fullName = $('#newName').value.trim().replace(/\s+/g, ' ');
    const role = $('#newRole').value, branchId = $('#newBranch').value;
    if (fullName.length < 3 || fullName.length > 100) { toast('The full name must be between 3 and 100 characters.', 'warn'); return; }
    if (!NAME_RE.test(fullName)) { toast('The full name can only contain letters, spaces, periods, hyphens and apostrophes.', 'warn'); return; }
    if (role !== ROLE.ADMIN && !branchId) { toast('Select a branch for this role.', 'warn'); return; }
    const { ok, data } = await api(`/users/${id}`, 'PUT', { fullName, role, branchId: role === ROLE.ADMIN ? null : Number(branchId) });
    if (!ok) { toast(data.error || 'The user could not be updated.', 'err'); return; }
    toast(data.sessionClosed ? 'User updated. Their session was closed so the new permissions apply.' : 'User updated.');
    if (id === S.user.id) { S.user.name = fullName; $('#userName').textContent = fullName; }
    S.editUser = null;
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

    // RF-02 / RF-03: branches and tables are edited and deactivated, never deleted
    const editing = S.editBranch ? S.branches.find(b => b.id === S.editBranch) : null;
    const branchForm = `<section class="card"><div class="card-head"><h3>${editing ? 'Edit branch' : 'Create branch'}</h3></div>
        <div class="field"><label>Branch name *</label><input id="branchName" placeholder="e.g. North Branch" maxlength="50" value="${esc(editing ? editing.name : '')}"></div>
        <div class="field"><label>Address *</label><input id="branchAddress" placeholder="e.g. Calle 85 # 12-45" maxlength="100" value="${esc(editing ? editing.address : '')}"></div>
        ${editing
            ? `<div class="btn-row"><button class="btn" onclick="saveBranch(${editing.id})">Save changes</button>
                   <button class="btn btn-ghost" onclick="S.editBranch=null;go('branches')">Cancel edit</button></div>`
            : '<button class="btn btn-block" onclick="saveBranch()">Register branch</button>'}</section>`;

    const tableForm = `<section class="card"><div class="card-head"><h3>Create table per branch</h3></div>
        <div class="field"><label>Branch *</label><select id="tableBranch">${optionsHTML(S.branches.filter(b => b.active), S.branchId, 'Select branch…')}</select></div>
        <div class="field"><label>Table number *</label><input type="number" id="tableNumber" min="1" max="9999" placeholder="e.g. 4"></div>
        <button class="btn btn-block" onclick="createTable()">Add table</button></section>`;

    const list = `<section class="card"><div class="card-head"><h3>Registered branches</h3><small>${S.branches.length} branch(es)</small></div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Branch</th><th>Address</th><th>Status</th><th></th></tr></thead><tbody>
        ${S.branches.map(b => `<tr><td><b>${esc(b.name)}</b></td><td>${esc(b.address)}</td>
            <td>${b.active ? '<span class="badge active">Active</span>' : '<span class="badge warn">Inactive</span>'}</td>
            <td class="act"><button class="btn btn-sm btn-ghost" onclick="S.editBranch=${b.id};go('branches')">Edit</button>
                ${b.active ? `<button class="btn btn-sm btn-danger" onclick="setBranchStatus(${b.id},false)">Deactivate</button>`
                           : `<button class="btn btn-sm btn-ok" onclick="setBranchStatus(${b.id},true)">Activate</button>`}</td></tr>`).join('')}
        </tbody></table></div></section>`;

    // Tables of one branch: renumber and availability
    if (!S.tablesBranch || !S.branches.some(b => b.id === S.tablesBranch)) S.tablesBranch = S.branchId || (S.branches[0] || {}).id;
    const t = S.tablesBranch ? await api(`/tables?branch_id=${S.tablesBranch}`) : { ok: true, data: [] };
    const tableStatus = (x) => x.status === 'inactive' ? '<span class="badge warn">Inactive</span>'
        : (x.status === 'occupied' ? '<span class="badge locked">Occupied</span>' : '<span class="badge active">Available</span>');
    const tablesCard = `<section class="card"><div class="card-head"><h3>Tables</h3>
            <select onchange="S.tablesBranch=Number(this.value);go('branches')">${optionsHTML(S.branches, S.tablesBranch)}</select></div>
        ${t.ok && t.data.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Table</th><th>Status</th><th></th></tr></thead><tbody>
            ${t.data.map(x => `<tr><td><b>#${x.number}</b></td><td>${tableStatus(x)}</td>
                <td class="act"><button class="btn btn-sm btn-ghost" onclick="renumberTable(${x.id},${x.number})">Change number</button>
                    ${x.status === 'inactive' ? `<button class="btn btn-sm btn-ok" onclick="setTableStatus(${x.id},true)">Activate</button>`
                      : `<button class="btn btn-sm btn-danger" ${x.status === 'occupied' ? 'disabled title="It has an open order"' : ''} onclick="setTableStatus(${x.id},false)">Deactivate</button>`}</td></tr>`).join('')}
            </tbody></table></div>` : `<div class="empty">${t.ok ? 'This branch has no tables yet.' : esc(t.data.error)}</div>`}
    </section>`;

    return `<div class="split even"><div class="stack">${branchForm}${tableForm}</div><div class="stack">${list}${tablesCard}</div></div>`;
}

// Creates a branch, or saves the edited one (id)
async function saveBranch(id) {
    const name = $('#branchName').value.trim(), address = $('#branchAddress').value.trim();
    if (!name || !address) { toast('Please fill in all branch fields.', 'warn'); return; }
    const { ok, data } = id ? await api(`/branches/${id}`, 'PUT', { name, address }) : await api('/branches', 'POST', { name, address });
    if (!ok) { toast(data.error || 'The branch could not be saved.', 'err'); return; }
    toast(id ? `Branch "${name}" updated.` : `Branch "${name}" registered successfully.`);
    if (!id && !S.branchId) S.branchId = data.id;
    S.editBranch = null;
    await refreshBranches();
    go('branches');
}

async function setBranchStatus(id, active) {
    const b = S.branches.find(x => x.id === id);
    if (!active && !confirm(`Deactivate the branch "${b ? b.name : ''}"?\nIts staff will not be able to sign in and it will not receive orders until it is activated again.`)) return;
    const { ok, status, data } = await api(`/branches/${id}/status`, 'PATCH', { active });
    if (status === 409) { notice('The branch cannot be deactivated', data.error); return; }
    if (!ok) { toast(data.error || 'The status could not be changed.', 'err'); return; }
    toast(`Branch ${active ? 'activated' : 'deactivated'}.`);
    await refreshBranches();
    go('branches');
}

async function renumberTable(id, current) {
    const v = prompt(`New number for table #${current}:`, String(current));
    if (v === null || v.trim() === String(current)) return;
    const { ok, data } = await api(`/tables/${id}`, 'PUT', { number: Number(v) });
    if (!ok) { toast(data.error || 'The table could not be updated.', 'err'); return; }
    toast(`Table #${current} is now #${Number(v)}.`);
    go('branches');
}

async function setTableStatus(id, active) {
    const { ok, status, data } = await api(`/tables/${id}/status`, 'PATCH', { active });
    if (status === 409) { notice('The table cannot be deactivated', data.error); return; }
    if (!ok) { toast(data.error || 'The status could not be changed.', 'err'); return; }
    toast(`Table ${active ? 'activated' : 'deactivated'}.`);
    go('branches');
}

// Reloads the branch list used by the menus (names or status may have changed)
async function refreshBranches() {
    const r = await api('/branches');
    if (r.ok) S.branches = r.data;
}

async function createTable() {
    const branchId = $('#tableBranch').value, number = $('#tableNumber').value.trim();
    if (!branchId || !number) { toast('Select a branch and enter the table number.', 'warn'); return; }
    const { ok, data } = await api('/tables', 'POST', { branchId: Number(branchId), number: Number(number) });
    if (!ok) { toast(data.error || 'The table could not be created.', 'err'); return; }
    toast(`Table #${number} created successfully.`);
    S.tablesBranch = Number(branchId);
    go('branches');
}
