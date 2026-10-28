'use strict';
// =====================================================================
//  Liar's Bar - Management System · core
//  Session, navigation, shared helpers and startup.
//  The pages live in js/pages-*.js (loaded before this file).
// =====================================================================

const IDLE_LIMIT_MS = 180000;   // 3 minutes of inactivity (RNF-07): the session ends exactly then, here and on the server
const WARNING_SECONDS = 28;     // the countdown is shown during the last 28 seconds of those 3 minutes
const PING_EVERY_MS = 5000;     // tells the server you are still active (at most every 5 seconds)
const LOW_STOCK = 5;            // at or below this, stock is marked "Low"
const MAX_AMOUNT = 99999999;    // largest money value the database accepts (DECIMAL(10,2))

const ROLE = { ADMIN: 'Administrator', CASHIER: 'Cashier', WAITER: 'Waiter' };
const CASHIERS = [ROLE.ADMIN, ROLE.CASHIER];              // register payments, invoices (the admin can do cashier work)
const STOCKERS = [ROLE.ADMIN, ROLE.CASHIER];              // add stock to the inventory
const PAYMENT_METHODS = {
    cash:        { name: 'Cash',        icon: '<i class="fa-solid fa-money-bill-wave"></i>' },
    credit_card: { name: 'Credit card', icon: '<i class="fa-solid fa-credit-card"></i>' },
    debit_card:  { name: 'Debit card',  icon: '<i class="fa-solid fa-money-check"></i>' },
    // Closes the order now; the payment stays pending until it is collected from the Cash desk
    deferred:    { name: 'Deferred payment', icon: '<i class="fa-solid fa-clock"></i>' }
};

// Only for the "Demo quick access" buttons. Remove this in production.
const DEMO_PASSWORDS = { cmendoza: 'Admin123*', aperez: 'Cajero123*', lgarcia: 'Mesero123*' };

// Global application state
const S = {
    token: sessionStorage.getItem('lb_token'),
    user: null,
    branches: [],
    branchId: null,        // branch being worked on (the Administrator chooses it, everyone else has a fixed one)
    page: null,
    params: {},
    navId: 0,
    selTable: null, selTableNum: null,
    statusFilter: '',
    cashAll: false,        // Administrator: cash desk showing every branch
    catalog: [],
    products: [], types: [], suppliers: [],
    users: [],
    inventory: [],
    checkout: null,        // order being charged: { id, total, method }
    sort: { criterion: 'price-desc', method: 'merge' }, sortInfo: '',   // default: HIGHEST to LOWEST price
    editProduct: null, editType: null, editSupplier: null, draftProduct: null,
    report: null,          // sales report filters { from, to, branch }
    invoiceFilter: null,   // { from, to }
    audit: null            // audit trail filters { from, to, userId, category, q }
};

let idleTimer = null, countdownTimer = null, timeoutVisible = false, lastPing = 0;

// ---------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Colombian pesos: dot as thousands separator and no decimals, e.g. $55.000
const money = (n) => {
    const v = Math.round(Number(n) || 0);
    return (v < 0 ? '-$' : '$') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
};
const fmtDate = (d) => new Date(d).toLocaleString('en-US', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtTime = (d) => new Date(d).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
const pad2 = (n) => String(n).padStart(2, '0');
const isoDay = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const firstOfMonth = () => { const d = new Date(); return isoDay(new Date(d.getFullYear(), d.getMonth(), 1)); };
const branchName = () => (S.branches.find(b => b.id === S.branchId) || {}).name || '—';
const isAdmin = () => !!S.user && S.user.role === ROLE.ADMIN;
const hasRole = (roles) => !!S.user && roles.includes(S.user.role);
const canStock = () => hasRole(STOCKERS);
const canCharge = () => hasRole(CASHIERS);
const bq = () => `branch_id=${S.branchId || ''}`;
const methodName = (m) => (PAYMENT_METHODS[m] || { name: m }).name;

// Modal with a longer explanation that stays until the user closes it
function notice(title, msg) {
    $('#noticeTitle').textContent = title;
    $('#noticeText').textContent = msg;
    $('#modalNotice').hidden = false;
    $('#noticeOk').focus();
}

function toast(msg, type = 'ok') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 3400);
    setTimeout(() => el.remove(), 3900);
}

function handleSessionErrors(status, data) {
    if (status === 401 && data.code === 'SESSION_EXPIRED') sessionExpired();
    if (status === 401 && data.code === 'SESSION_REPLACED') sessionExpired(data.error);   // the account was opened on another device
}

async function api(path, method = 'GET', body) {
    const res = await fetch('/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* response without body */ }
    handleSessionErrors(res.status, data);
    return { ok: res.ok, status: res.status, data };
}

// Downloads a file returned by the API (e.g. the Excel export)
async function apiDownload(path, fallbackName) {
    const res = await fetch('/api' + path, { headers: { Authorization: 'Bearer ' + S.token } });
    if (!res.ok) {
        let data = {};
        try { data = await res.json(); } catch (e) { /* no body */ }
        handleSessionErrors(res.status, data);
        return { ok: false, error: data.error || 'The file could not be downloaded.' };
    }
    const blob = await res.blob();
    const name = ((res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/) || [])[1] || fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return { ok: true, name, size: blob.size };
}

const optionsHTML = (list, selected, placeholder) =>
    (placeholder ? `<option value="">${placeholder}</option>` : '') +
    list.map(x => `<option value="${x.id}" ${String(x.id) === String(selected) ? 'selected' : ''}>${esc(x.name)}</option>`).join('');

const noBranch = () => `<div class="card empty"><span class="big"><i class="fa-solid fa-building"></i></span>No branch selected.<br>
    ${isAdmin() ? 'Create one in <b>Branches &amp; tables</b>.' : 'Ask the administrator to assign you a branch.'}</div>`;
const errCard = (msg) => `<div class="card empty"><span class="big"><i class="fa-solid fa-triangle-exclamation"></i></span>${esc(msg || 'The information could not be loaded.')}</div>`;
const statusBadge = (s) => `<span class="badge ${esc(s)}">${esc(s)}</span>`;

// ---------------------------------------------------------------------
//  Access screens / application
// ---------------------------------------------------------------------
function showAuth(viewId) {
    $('#shell').hidden = true;
    $('#auth').hidden = false;
    document.body.classList.remove('in-app');
    $$('#auth .view').forEach(v => v.classList.toggle('active', v.id === viewId));
    $('#modalLogout').hidden = true;
    $('#modalTimeout').hidden = true;
}

function showShell() {
    $('#auth').hidden = true;
    $('#shell').hidden = false;
    document.body.classList.add('in-app');
}

function clearLocalSession() {
    S.token = null; S.user = null; S.branches = []; S.branchId = null; S.selTable = null;
    S.report = null; S.audit = null; S.invoiceFilter = null; S.cashAll = false;
    sessionStorage.removeItem('lb_token');
    clearTimeout(idleTimer);
    clearInterval(countdownTimer);
    timeoutVisible = false;
}

function sessionExpired(msg = 'Your session expired. Please sign in again.') {
    if (!S.user) return;
    clearLocalSession();
    showAuth('view-login');
    toast(msg, 'warn');
}

// ---------------------------------------------------------------------
//  Login (HU-001/002) — lock after 3 attempts (HU-005) — single session (HU-006)
// ---------------------------------------------------------------------
const userInput = $('#userInput');
const passwordInput = $('#passwordInput');
const connectBtn = $('#connectBtn');

function validateLoginForm() {
    const ok = userInput.value.trim() !== '' && passwordInput.value.trim() !== '';
    connectBtn.classList.toggle('disabled', !ok);
    if (ok) connectBtn.removeAttribute('disabled'); else connectBtn.setAttribute('disabled', 'true');
}
userInput.addEventListener('input', validateLoginForm);
passwordInput.addEventListener('input', validateLoginForm);

function quickAccess(username) {
    userInput.value = username;
    passwordInput.value = DEMO_PASSWORDS[username] || '';
    validateLoginForm();
}

// force = true → closes the session the account has open on another device (requires the right password)
async function login(force) {
    const username = userInput.value.trim();
    const { status, data } = await api('/login', 'POST', { username, password: passwordInput.value.trim(), force });

    if (status === 200) {
        S.token = data.token;
        sessionStorage.setItem('lb_token', S.token);
        await enterApp(data.user);
        if (force) toast('The previous session of this account was closed.', 'warn');
    } else if (data.code === 'LOCKED') {
        showAuth('view-locked');
    } else if (data.code === 'ACTIVE_SESSION') {
        $('#activeUserAccount').textContent = username;
        showAuth('view-active-session');
    } else if (data.code === 'BAD_CREDENTIALS') {
        // Generic on purpose (OWASP): it does not say whether the username or the password was wrong
        toast(data.error, 'err');
        if (force) showAuth('view-login');
    } else {
        toast(data.error || 'Could not sign in.', 'err');
    }
}

$('#loginForm').addEventListener('submit', (e) => { e.preventDefault(); login(false); });
$('#forceLogin').addEventListener('click', () => login(true));

$('#linkForgot').addEventListener('click', (e) => { e.preventDefault(); showAuth('view-change-password'); });
$('#cancelChangePass').addEventListener('click', (e) => { e.preventDefault(); $('#changePasswordForm').reset(); showAuth('view-login'); });
$('#changePasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fullName = $('#cpName').value.trim().replace(/\s+/g, ' ');
    const username = $('#cpUser').value.trim();
    const newPassword = $('#cpNew').value, confirmation = $('#cpConfirm').value;
    if (newPassword !== confirmation) { toast('The new passwords do not match.', 'err'); return; }
    const ep = passwordError(newPassword);
    if (ep) { toast(ep, 'err'); return; }

    // RF-24: identified by full name + username. No current password: the server only accepts it
    // if the administrator already authorized the change.
    const { ok, data } = await api('/change-password', 'POST', { fullName, username, newPassword });
    if (ok) {
        e.target.reset();
        userInput.value = username; passwordInput.value = ''; validateLoginForm();
        showAuth('view-login');
        toast('Password updated. You can now sign in with the new one.');
    } else if (data.code === 'NOT_AUTHORIZED') {
        toast(data.error, 'warn');
    } else {
        toast(data.error || 'The password could not be changed.', 'err');
    }
});
$('#backFromLock').addEventListener('click', () => showAuth('view-login'));
$('#backFromActiveSession').addEventListener('click', () => showAuth('view-login'));

async function enterApp(user) {
    S.user = user;
    const r = await api('/branches');
    S.branches = r.ok ? r.data : [];
    const firstBranch = S.branches.find(b => b.active) || S.branches[0];
    S.branchId = isAdmin() ? (firstBranch ? firstBranch.id : null) : user.branchId;

    $('#userName').textContent = user.name;
    $('#userRole').textContent = user.role;
    $('#userAvatar').textContent = user.name.trim().charAt(0).toUpperCase();
    buildNav();
    showShell();
    startIdleTimer();          // the login / session check just touched the server
    go('home');
}

// ---------------------------------------------------------------------
//  Password rule (password change and user registration)
//  Returns the error message, or null when valid (same rules as the server)
// ---------------------------------------------------------------------
function passwordError(p) {
    if (p.length < 8 || !/[A-Z]/.test(p) || !/\d/.test(p)) return 'The password must have at least 8 characters, one uppercase letter and one number.';
    if (p.length > 64) return 'The password cannot be longer than 64 characters.';
    if (/\s/.test(p)) return 'The password cannot contain spaces.';
    return null;
}

// ---------------------------------------------------------------------
//  Sign out (HU-003) and inactivity (HU-004)
// ---------------------------------------------------------------------
async function signOut() {
    // The local session is always closed, even if the server cannot be reached
    if (S.token) { try { await api('/logout', 'POST'); } catch (e) { /* server unreachable */ } }
    clearLocalSession();
    userInput.value = ''; passwordInput.value = '';
    validateLoginForm();
}

$('#btnOpenLogoutModal').addEventListener('click', () => {
    $('#logoutUserName').textContent = `${S.user.name} — ${S.user.role}`;
    $('#modalLogout').hidden = false;
});
$('#noticeOk').addEventListener('click', () => { $('#modalNotice').hidden = true; });
$('#cancelLogout').addEventListener('click', () => { $('#modalLogout').hidden = true; });
$('#confirmLogout').addEventListener('click', async () => {
    await signOut();
    showAuth('view-login');
    toast('Signed out successfully.');
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#modalLogout').hidden = true; $('#modalNotice').hidden = true; } });

// The 3 minutes count from the last time the server heard from us, so the client and the server
// close the session at the same moment. Activity pings the server at most every PING_EVERY_MS.
function startIdleTimer() {
    lastPing = Date.now();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(triggerInactivityTimeout, IDLE_LIMIT_MS - WARNING_SECONDS * 1000);
}

function resetIdleTimer() {
    if (!S.user || timeoutVisible) return;
    if (Date.now() - lastPing < PING_EVERY_MS) return;
    startIdleTimer();
    api('/keepalive', 'POST');
}

function triggerInactivityTimeout() {
    timeoutVisible = true;
    $('#modalLogout').hidden = true;
    $('#modalTimeout').hidden = false;
    let secondsLeft = WARNING_SECONDS;
    $('#timer-text').textContent = `${secondsLeft}s`;
    $('#countdownNumber').textContent = `${secondsLeft} seconds`;

    clearInterval(countdownTimer);
    countdownTimer = setInterval(async () => {
        secondsLeft--;
        $('#timer-text').textContent = `${secondsLeft}s`;
        $('#countdownNumber').textContent = `${secondsLeft} seconds`;
        if (secondsLeft <= 0) {
            clearInterval(countdownTimer);         // stop first: signOut may fail if the server is unreachable
            await signOut();
            showAuth('view-login');
            toast('Session closed after a long period of inactivity (3 minutes).', 'warn');
        }
    }, 1000);
}

$('#timeoutForceLogout').addEventListener('click', async () => { await signOut(); showAuth('view-login'); });
$('#timeoutKeepAlive').addEventListener('click', () => {
    clearInterval(countdownTimer);
    timeoutVisible = false;
    $('#modalTimeout').hidden = true;
    lastPing = 0;
    resetIdleTimer();
});
['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(evt => window.addEventListener(evt, resetIdleTimer));

// ---------------------------------------------------------------------
//  Navigation (side menu). An item with a role list is only shown to those roles;
//  the Administrator sees everything (management + waiter + cashier work).
// ---------------------------------------------------------------------
const NAV = [
    { group: 'Operations', items: [['home', '<i class="fa-solid fa-house"></i>', 'Home'], ['tables', '<i class="fa-solid fa-chair"></i>', 'Tables & orders'], ['cash', '<i class="fa-solid fa-money-bill-wave"></i>', 'Cash desk', CASHIERS],
                                   ['invoices', '<i class="fa-solid fa-receipt"></i>', 'Invoices', CASHIERS], ['report', '<i class="fa-solid fa-chart-line"></i>', 'Sales report', CASHIERS],
                                   ['orders', '<i class="fa-solid fa-clipboard-list"></i>', 'Orders'], ['inventory', '<i class="fa-solid fa-boxes-stacked"></i>', 'Inventory']] },
    { group: 'Catalog', admin: true, items: [['products', '<i class="fa-solid fa-martini-glass-citrus"></i>', 'Products'], ['types', '<i class="fa-solid fa-tags"></i>', 'Product types'], ['suppliers', '<i class="fa-solid fa-truck"></i>', 'Suppliers']] },
    { group: 'Administration', admin: true, items: [['audit', '<i class="fa-solid fa-user-secret"></i>', 'Audit trail'],
                                                    ['users', '<i class="fa-solid fa-users"></i>', 'Users'], ['branches', '<i class="fa-solid fa-building"></i>', 'Branches & tables']] }
];

function buildNav() {
    $('#nav').innerHTML = NAV.filter(g => !g.admin || isAdmin()).map(g =>
        `<div class="nav-group">${g.group}</div>` +
        g.items.filter(([, , , roles]) => !roles || hasRole(roles))
            .map(([id, ico, label]) => `<button class="nav-item" data-page="${id}"><span class="ni">${ico}</span>${label}</button>`).join('')
    ).join('');
}

$('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item');
    if (b) go(b.dataset.page);
});

const openSidebar = () => { $('#sidebar').classList.add('open'); $('#backdrop').classList.add('show'); };
const closeSidebar = () => { $('#sidebar').classList.remove('open'); $('#backdrop').classList.remove('show'); };
$('#menuBtn').addEventListener('click', openSidebar);
$('#backdrop').addEventListener('click', closeSidebar);

const PAGES = {
    home:      { title: 'Home', sub: 'Operations overview', branch: true, render: pHome },
    tables:    { title: 'Tables & orders', sub: 'Select an available table to start an order', branch: true, render: pTables },
    cash:      { title: 'Cash desk', sub: 'Open orders pending payment', branch: true, roles: CASHIERS, render: pCashDesk },
    checkout:  { title: 'Charge order', sub: '', nav: 'cash', roles: CASHIERS, render: pCheckout, after: renderMethod },
    invoices:  { title: 'Invoices', sub: 'Invoices issued for paid orders', branch: true, roles: CASHIERS, render: pInvoices },
    invoice:   { title: 'Invoice', sub: '', nav: 'invoices', roles: CASHIERS, render: pInvoice },
    orders:    { title: 'Orders', sub: 'Orders of the branch', branch: true, render: pOrders },
    order:     { title: 'Order detail', sub: '', nav: 'orders', render: pOrder },
    inventory: { title: 'Inventory', sub: 'Stock per branch', branch: true, render: pInventory },
    products:  { title: 'Products', sub: 'Create and manage the catalog', admin: true, render: pProducts, after: updateMargin },
    types:     { title: 'Product types', sub: 'Create and manage categories', admin: true, render: pTypes },
    suppliers: { title: 'Suppliers', sub: 'Register, view and manage suppliers', admin: true, render: pSuppliers },
    report:    { title: 'Sales report', sub: 'Sales, cost and profit by date and branch', roles: CASHIERS, render: pReport },
    audit:     { title: 'Audit trail', sub: 'Who did what and when', admin: true, render: pAudit },
    users:     { title: 'Users', sub: 'Create, view, activate and deactivate', admin: true, render: pUsers },
    branches:  { title: 'Branches & tables', sub: 'Branch management', admin: true, render: pBranches }
};

function renderTopbar(P) {
    const box = $('#topbarRight');
    if (!P.branch) { box.innerHTML = ''; return; }
    if (isAdmin()) {
        box.innerHTML = `<label class="branch-pick"><i class="fa-solid fa-location-dot"></i> Branch
            <select onchange="changeBranch(this.value)">${optionsHTML(S.branches, S.branchId)}</select></label>`;
    } else {
        box.innerHTML = `<span class="chip"><i class="fa-solid fa-location-dot"></i> ${esc(branchName())}</span>`;
    }
}

function changeBranch(v) {
    S.branchId = Number(v) || null;
    S.selTable = null;
    if (S.page === 'order') go('tables');
    else if (S.page === 'checkout') go('cash');
    else go(S.page, S.params);
}

async function go(page, params = {}) {
    const P = PAGES[page];
    if (!P || !S.user) return;
    if (P.admin && !isAdmin()) { toast('Access denied: requires the Administrator profile.', 'err'); return; }
    if (P.roles && !hasRole(P.roles)) { toast('Access denied for your profile.', 'err'); return; }

    S.page = page; S.params = params;
    const my = ++S.navId;
    $('#pageTitle').textContent = P.title;
    $('#pageSub').textContent = P.sub || '';
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === (P.nav || page)));
    renderTopbar(P);
    closeSidebar();

    const c = $('#content');
    c.innerHTML = '<div class="loading">Loading…</div>';
    try {
        const out = await P.render();
        if (my !== S.navId) return;                    // the user already moved to another page
        const res = typeof out === 'string' ? { html: out } : out;
        c.innerHTML = res.html;
        if (res.title) $('#pageTitle').textContent = res.title;
        if (res.sub !== undefined) $('#pageSub').textContent = res.sub;
        if (P.after) P.after();
    } catch (err) {
        console.error(err);
        if (my === S.navId) c.innerHTML = errCard('The page could not be loaded.');
    }
    window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------
//  SORTING (uses sorting.js): by default HIGHEST to LOWEST price
// ---------------------------------------------------------------------
function sortList(list) {
    const r = Sorting.sort(list, S.sort.method, S.sort.criterion);
    S.sortInfo = `<b>${esc(r.method)}</b> · ${r.comparisons} comparisons · ${r.complexity}`;
    return r.list;
}

function sortToolbar() {
    const options = (obj, sel) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v.name}</option>`).join('');
    return `<div class="sort-bar">
        <label>Sort by <select id="sortCrit" onchange="changeSort()">${options(Sorting.criteria, S.sort.criterion)}</select></label>
        <label>Method <select id="sortMethod" onchange="changeSort()">${options(Sorting.methods, S.sort.method)}</select></label>
        <span class="sort-info" id="sortInfo">${S.sortInfo}</span></div>`;
}

function changeSort() {
    S.sort.criterion = $('#sortCrit').value;
    S.sort.method = $('#sortMethod').value;
    if (S.page === 'products') {
        $('#prodBody').innerHTML = productRows();
        filterRows(($('#prodSearch') || {}).value || '', '.prod-row');
    } else if (S.page === 'order') {
        S.catalog = sortList(S.catalog);
        $('#catList').innerHTML = S.catalog.map(catalogRow).join('');
        filterRows(($('#catSearch') || {}).value || '', '#catList .cat-row');
    }
    $('#sortInfo').innerHTML = S.sortInfo;
}

// Generic search filter for lists/tables (uses data-q on every row)
function filterRows(q, selector) {
    const t = q.toLowerCase().trim();
    $$(selector).forEach(r => { r.hidden = !(r.dataset.q || '').includes(t); });
}

// ---------------------------------------------------------------------
//  Startup: if the page is reloaded with a valid session, it resumes
// ---------------------------------------------------------------------
(async function restoreSession() {
    if (!S.token) return;
    const { ok, data } = await api('/me');
    if (ok) await enterApp(data.user);
    else clearLocalSession();
})();
