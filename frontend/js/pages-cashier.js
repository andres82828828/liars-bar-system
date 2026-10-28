'use strict';
// =====================================================================
//  CASHIER WORK — Cashier and Administrator (HU-030)
//  Cash desk (open orders), checkout (total + payment + change), invoices
// =====================================================================

// =====================================================================
//  CASH DESK: open orders per branch (HU-021)
//  The Administrator can see one branch or ALL branches.
// =====================================================================
async function pCashDesk() {
    const all = isAdmin() && S.cashAll;
    if (!all && !S.branchId) return noBranch();
    // The server filters by branch: the Cashier only receives the orders of their own
    const r = await api(`/orders?${all ? 'branch_id=all' : bq()}&status=open`);
    if (!r.ok) return errCard(r.data.error);
    const list = r.data;
    const pending = list.reduce((acc, x) => acc + x.total, 0);
    const toCharge = list.filter(x => x.units > 0).length;

    const stats = `<div class="stats">
        <div class="card stat"><div class="stat-ico y"><i class="fa-solid fa-clipboard-list"></i></div><div><div class="stat-num">${list.length}</div><div class="stat-lbl">Open orders</div></div></div>
        <div class="card stat"><div class="stat-ico r"><i class="fa-solid fa-hourglass-half"></i></div><div><div class="stat-num">${toCharge}</div><div class="stat-lbl">Pending payment</div></div></div>
        <div class="card stat"><div class="stat-ico g"><i class="fa-solid fa-money-bill-wave"></i></div><div><div class="stat-num" style="font-size:1.45rem">${money(pending)}</div><div class="stat-lbl">Total to collect</div></div></div>
    </div>`;

    const scope = isAdmin() ? `<div class="filters">
        <button class="fchip ${!all ? 'active' : ''}" onclick="setCashScope(false)"><i class="fa-solid fa-location-dot"></i> ${esc(branchName())}</button>
        <button class="fchip ${all ? 'active' : ''}" onclick="setCashScope(true)"><i class="fa-solid fa-building"></i> All branches</button></div>` : '';

    // Table (and branch), total and order selection
    const rows = list.map(x => `<tr class="cash-row" data-q="${esc(('table #' + x.table + ' ' + x.code + ' ' + x.branch).toLowerCase())}">
        <td><b>Table #${x.table}</b>${all ? `<br><small><i class="fa-solid fa-location-dot"></i> ${esc(x.branch)}</small>` : ''}</td>
        <td>${esc(x.code)}<br><small>Opened at ${fmtTime(x.createdAt)}</small></td>
        <td class="num">${x.units}</td>
        <td class="num"><b>${money(x.total)}</b></td>
        <td class="act">${x.units
            ? `<button class="btn btn-sm btn-ok" onclick="go('checkout',{id:${x.id}})">Charge</button>`
            : '<span class="badge gray">No products</span>'}
            <button class="btn btn-sm btn-ghost" onclick="go('order',{id:${x.id}})">View</button></td></tr>`).join('');

    return stats + `<section class="card">
        <div class="card-head"><h3>Open orders · ${all ? 'all branches' : esc(branchName())}</h3>
            <input class="search" placeholder="Search table or code…" oninput="filterRows(this.value,'.cash-row')"></div>
        ${scope ? `<div style="margin:-4px 0 14px">${scope}</div>` : ''}
        ${list.length
            ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Table</th><th>Order</th><th class="num">Units</th><th class="num">Total</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
            : `<div class="empty"><span class="big"><i class="fa-solid fa-circle-check"></i></span>There are no open orders${all ? '' : ' in this branch'}.</div>`}
    </section>`;
}

function setCashScope(all) { S.cashAll = all; go('cash'); }

// =====================================================================
//  CHECKOUT: total (HU-022) + payment (HU-023) + change (HU-024)
// =====================================================================
async function pCheckout() {
    S.checkout = null;
    const r = await api(`/orders/${S.params.id}`);
    if (!r.ok) return errCard(r.data.error);
    const o = r.data;
    if (o.status !== 'open') {
        return `<div class="card empty"><span class="big"><i class="fa-solid fa-circle-check"></i></span>This order is already <b>${esc(o.status)}</b>.<br>
            <button class="btn btn-sm" style="margin-top:12px" onclick="go('order',{id:${o.id}})">View detail</button></div>`;
    }
    if (!o.items.length) return errCard('The order has no products: there is nothing to charge.');

    // The total comes computed by the server from the products of the order
    S.checkout = { id: o.id, total: o.total, method: 'cash' };

    const rows = o.items.map(i => `<tr>
        <td>${esc(i.name)}<br><small>${esc(i.code)}</small></td>
        <td class="num">${i.quantity} × ${money(i.price)}</td><td class="num"><b>${money(i.subtotal)}</b></td></tr>`).join('');

    const summary = `<section class="card">
        <div class="ticket-head"><div><small>ORDER TO CHARGE</small><h3>${esc(o.code)}</h3></div>${statusBadge(o.status)}</div>
        <div class="ticket-meta">
            <div><span>Table</span><b>#${o.table}</b></div><div><span>Branch</span><b>${esc(o.branch)}</b></div>
            <div><span>Opened</span><b>${fmtDate(o.createdAt)}</b></div><div><span>Products</span><b>${o.units} unit(s)</b></div>
        </div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Product</th><th class="num">Qty × price</th><th class="num">Subtotal</th></tr></thead><tbody>${rows}</tbody></table></div>
        <div class="ticket-total"><span>Total to charge</span><strong>${money(o.total)}</strong></div>
    </section>`;

    const methods = Object.entries(PAYMENT_METHODS).map(([k, m]) => `<label class="method" data-method="${k}">
        <input type="radio" name="paymentMethod" value="${k}" ${k === 'cash' ? 'checked' : ''} onchange="setMethod('${k}')">
        <span class="mi">${m.icon}</span><span>${m.name}</span></label>`).join('');

    const form = `<section class="card">
        <div class="card-head"><h3>Register payment</h3></div>
        <div class="field"><label>Payment method *</label><div class="methods">${methods}</div></div>
        <div class="field"><label for="payAmount">Amount received *</label>
            <input type="number" id="payAmount" min="0" step="50" inputmode="decimal" placeholder="0" oninput="updateCheckout()"
                   onkeydown="if(event.key==='Enter')registerPayment()">
            <span class="hint" id="payHint"></span></div>
        <div class="quick" id="payQuick"></div>
        <div class="checkout-box">
            <div><span>Total</span><b>${money(o.total)}</b></div>
            <div><span>Received</span><b id="payReceived">—</b></div>
            <div class="change"><span>Change</span><b id="payChange">—</b></div>
        </div>
        <div class="breakdown" id="payBreakdown"></div>
        <div class="pay-msg" id="payMsg"></div>
        <p class="hint" style="margin:-6px 0 14px">When the payment is registered the order is <b>closed</b>, the table is <b>released</b> and the <b>invoice</b> is generated.</p>
        <div class="btn-row">
            <button class="btn btn-ghost" onclick="go('cash')"><i class="fa-solid fa-arrow-left"></i> Back to cash desk</button>
            <button class="btn btn-ok" id="btnPay" onclick="registerPayment()" disabled>Register payment</button>
        </div>
    </section>`;

    return { html: `<div class="split even">${summary}${form}</div>`, title: 'Charge · Table #' + o.table, sub: `${o.code} · ${o.branch}` };
}

// ---------------------------------------------------------------------
//  CHANGE FOR CASH PAYMENTS (HU-024)
//  detect cash → method === 'cash' · capture amount received → #payAmount
//  compare with total / compute difference → validatePayment() · show change → updateCheckout()
// ---------------------------------------------------------------------

// Colombian bills and coins, from largest to smallest
const DENOMINATIONS = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50];

// GREEDY algorithm: at each step it takes the largest denomination that fits in what is left.
// With a "canonical" currency system like the Colombian one it gives the FEWEST pieces.
// Complexity O(k), k = number of denominations (11).
function changeBreakdown(change) {
    let rest = Math.round(change);
    const pieces = [];
    for (const d of DENOMINATIONS) {
        const n = Math.floor(rest / d);
        if (n > 0) { pieces.push({ value: d, count: n }); rest -= n * d; }
    }
    return { pieces, rest };     // rest > 0 only when less than $50 is left (there is no coin for it)
}

function breakdownHTML(change) {
    const { pieces, rest } = changeBreakdown(change);
    if (!pieces.length && !rest) return '';
    return `<span class="breakdown-title">Hand over:</span>` +
        pieces.map(p => `<span class="piece ${p.value >= 1000 ? 'bill' : 'coin'}">${p.count} × ${money(p.value)}</span>`).join('') +
        (rest ? `<span class="piece rest">+ ${money(rest)} without coin</span>` : '');
}

// Suggested cash amounts: exact and the next "round" bill
function cashSuggestions(total) {
    const list = [total];
    [10000, 20000, 50000, 100000].forEach(b => {
        const v = Math.ceil(total / b) * b;
        if (v > total && !list.includes(v)) list.push(v);
    });
    return list;
}

// Validates the amount received for the method (same rules as the server). Works in cents.
function validatePayment(total, method, amount) {
    if (!PAYMENT_METHODS[method]) return { ok: false, msg: 'Select a payment method.' };
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, msg: 'Enter the amount received.' };
    if (amount > MAX_AMOUNT) return { ok: false, type: 'err', msg: `The amount cannot exceed ${money(MAX_AMOUNT)}.` };
    const tC = Math.round(total * 100), aC = Math.round(amount * 100);
    if (method === 'cash' && aC < tC) return { ok: false, type: 'err', msg: `Insufficient amount: ${money((tC - aC) / 100)} is missing.` };
    if (method !== 'cash' && aC !== tC) return { ok: false, type: 'err', msg: `With a card the exact total is charged (${money(total)}).` };
    const change = (aC - tC) / 100;
    return { ok: true, type: 'ok', change, msg: change > 0 ? `Give ${money(change)} in change to the customer.` : 'Correct amount, no change.' };
}

function setMethod(method) {
    if (!S.checkout) return;
    S.checkout.method = method;
    renderMethod();
}

// Adapts the form to the chosen method: with a card the amount is fixed (= total)
function renderMethod() {
    const c = S.checkout, input = $('#payAmount');
    if (!c || !input) return;
    const cash = c.method === 'cash';
    $$('.method').forEach(l => l.classList.toggle('sel', l.dataset.method === c.method));
    input.disabled = !cash;
    input.value = cash ? '' : c.total;
    $('#payHint').textContent = cash
        ? 'Money handed over by the customer. It must be equal to or greater than the total.'
        : 'With a card the exact order total is charged.';
    $('#payQuick').innerHTML = cash
        ? cashSuggestions(c.total).map(v => `<button class="fchip" type="button" onclick="$('#payAmount').value=${v};updateCheckout()">${v === c.total ? 'Exact' : money(v)}</button>`).join('')
        : '';
    updateCheckout();
    if (cash) input.focus();
}

// Recomputes received / change live and enables the button only when the amount is valid
function updateCheckout() {
    const c = S.checkout, input = $('#payAmount');
    if (!c || !input) return;
    const amount = input.value === '' ? NaN : Number(input.value);
    const r = validatePayment(c.total, c.method, amount);
    const cash = c.method === 'cash';
    $('#payReceived').textContent = Number.isFinite(amount) && amount > 0 ? money(amount) : '—';
    // Change only exists for cash; it does not apply to cards
    $('#payChange').textContent = !cash ? 'N/A' : r.ok ? money(r.change) : '—';
    $('#payBreakdown').innerHTML = cash && r.ok && r.change > 0 ? breakdownHTML(r.change) : '';
    const msg = $('#payMsg');
    msg.textContent = r.msg;
    msg.className = 'pay-msg ' + (r.type || '');
    $('#btnPay').disabled = !r.ok;
}

async function registerPayment() {
    const c = S.checkout;
    if (!c) return;
    const amount = Number($('#payAmount').value);
    const r = validatePayment(c.total, c.method, amount);
    if (!r.ok) { toast(r.msg, 'warn'); return; }
    if (!confirm(`Register the payment of ${money(c.total)} by ${methodName(c.method)}?${r.change ? `\nChange to give: ${money(r.change)}` : ''}`)) return;

    $('#btnPay').disabled = true;
    const { ok, status, data } = await api(`/orders/${c.id}/payment`, 'POST', { method: c.method, amountReceived: amount });
    if (!ok) {
        toast(data.error || 'The payment could not be registered.', 'err');
        if (status === 409 || status === 404 || status === 403) go('cash');   // already paid / no longer exists
        else updateCheckout();
        return;
    }
    S.checkout = null;
    toast(`Payment registered · order closed · table #${data.table} released · invoice ${data.invoiceNumber}${data.change ? ` · change ${money(data.change)}` : ''}`);
    go('invoice', { id: data.invoiceId });
}

// =====================================================================
//  INVOICES
// =====================================================================
async function pInvoices() {
    const all = isAdmin() && S.cashAll;
    if (!all && !S.branchId) return noBranch();
    if (!S.invoiceFilter) S.invoiceFilter = { from: firstOfMonth(), to: isoDay() };
    const f = S.invoiceFilter;
    const r = await api(`/invoices?${all ? 'branch_id=all' : bq()}&from=${f.from}&to=${f.to}`);
    if (!r.ok) return errCard(r.data.error);
    const list = r.data;
    const total = list.reduce((a, x) => a + x.total, 0);

    const scope = isAdmin() ? `<div class="filters">
        <button class="fchip ${!all ? 'active' : ''}" onclick="S.cashAll=false;go('invoices')"><i class="fa-solid fa-location-dot"></i> ${esc(branchName())}</button>
        <button class="fchip ${all ? 'active' : ''}" onclick="S.cashAll=true;go('invoices')"><i class="fa-solid fa-building"></i> All branches</button></div>` : '';

    const rows = list.map(x => `<tr class="inv-row" data-q="${esc((x.number + ' ' + x.orderCode + ' table #' + x.table + ' ' + x.branch).toLowerCase())}">
        <td><b>${esc(x.number)}</b></td><td>${fmtDate(x.issuedAt)}</td>
        <td>${esc(x.orderCode)}<br><small>Table #${x.table}${all ? ' · ' + esc(x.branch) : ''}</small></td>
        <td>${(PAYMENT_METHODS[x.method] || {}).icon || ''} ${esc(methodName(x.method))}</td>
        <td class="num"><b>${money(x.total)}</b></td>
        <td class="act"><button class="btn btn-sm btn-dark" onclick="go('invoice',{id:${x.id}})">View</button></td></tr>`).join('');

    return `<section class="card">
        <div class="filter-bar">
            <div class="field"><label>From</label><input type="date" id="invFrom" value="${f.from}" max="${isoDay()}"></div>
            <div class="field"><label>To</label><input type="date" id="invTo" value="${f.to}" max="${isoDay()}"></div>
            <button class="btn" onclick="applyInvoiceFilter()">Search</button>
            ${scope}
        </div>
    </section>
    <section class="card">
        <div class="card-head"><h3>Invoices · ${all ? 'all branches' : esc(branchName())}</h3>
            <input class="search" placeholder="Search invoice, order or table…" oninput="filterRows(this.value,'.inv-row')"></div>
        <p class="hint" style="margin:-6px 0 12px">${list.length} invoice(s) · ${money(total)} invoiced between ${f.from} and ${f.to}.</p>
        ${list.length
            ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Invoice</th><th>Issued</th><th>Order</th><th>Method</th><th class="num">Total</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
            : `<div class="empty"><span class="big"><i class="fa-solid fa-receipt"></i></span>No invoices in this period.</div>`}
    </section>`;
}

function applyInvoiceFilter() {
    const from = $('#invFrom').value, to = $('#invTo').value;
    if (!from || !to) { toast('Select both dates.', 'warn'); return; }
    if (from > to) { toast('The start date cannot be after the end date.', 'warn'); return; }
    S.invoiceFilter = { from, to };
    go('invoices');
}

// Invoice format: business data, branch, invoice number and date, order and table,
// products with quantities and prices, total, payment method, amount received and change
async function pInvoice() {
    const r = await api(`/invoices/${S.params.id}`);
    if (!r.ok) return errCard(r.data.error);
    const inv = r.data, p = inv.payment || {};
    const m = PAYMENT_METHODS[p.method] || { name: p.method, icon: '' };
    const cash = p.method === 'cash';

    const rows = inv.items.map(i => `<tr>
        <td class="num">${i.quantity}</td><td>${esc(i.name)}<br><small>${esc(i.code)}</small></td>
        <td class="num">${money(i.price)}</td><td class="num">${money(i.subtotal)}</td></tr>`).join('');

    const html = `<div class="btn-row no-print" style="margin-bottom:16px">
            <button class="btn btn-ghost" onclick="go('invoices')"><i class="fa-solid fa-arrow-left"></i> Invoices</button>
            <button class="btn btn-ghost" onclick="go('order',{id:${inv.order.id}})">View order</button>
            <button class="btn" onclick="window.print()"><i class="fa-solid fa-print"></i> Print</button>
        </div>
        <article class="invoice-paper" id="invoicePaper">
            <header class="inv-head">
                <div><div class="inv-brand"><img src="img/logo.png" alt=""> ${esc(inv.business.name)}</div>
                    <small>${esc(inv.business.taxId)} · ${esc(inv.business.phone)}</small><br>
                    <small>Branch <b>${esc(inv.branch.name)}</b> · ${esc(inv.branch.address)}</small></div>
                <div class="inv-number"><small>INVOICE</small><b>${esc(inv.number)}</b><small>${fmtDate(inv.issuedAt)}</small></div>
            </header>
            <div class="inv-meta">
                <div><span>Order</span><b>${esc(inv.order.code)}</b></div>
                <div><span>Table</span><b>#${inv.order.table}</b></div>
                <div><span>Opened</span><b>${fmtDate(inv.order.createdAt)}</b></div>
                <div><span>Closed</span><b>${inv.order.closedAt ? fmtDate(inv.order.closedAt) : '—'}</b></div>
                ${p.cashier ? `<div><span>Cashier</span><b>${esc(p.cashier)}</b></div>` : ''}
            </div>
            <table class="tbl inv-items"><thead><tr><th class="num">Qty</th><th>Product</th><th class="num">Unit price</th><th class="num">Subtotal</th></tr></thead>
                <tbody>${rows}</tbody></table>
            <div class="inv-totals">
                <div><span>Units</span><b>${inv.units}</b></div>
                <div class="inv-total"><span>TOTAL</span><b>${money(inv.total)}</b></div>
            </div>
            <div class="inv-payment">
                <div><span>Payment method</span><b>${m.icon} ${esc(m.name)}</b></div>
                <div><span>Amount received</span><b>${money(p.amountReceived ?? p.amountPaid)}</b></div>
                <div><span>Change</span><b>${cash ? money(p.change) : 'N/A'}</b></div>
                <div><span>Paid at</span><b>${p.paidAt ? fmtDate(p.paidAt) : '—'}</b></div>
            </div>
            <footer class="inv-foot">Thank you for your visit! · This document is the sales invoice of order ${esc(inv.order.code)}.</footer>
        </article>`;
    return { html, title: 'Invoice ' + inv.number, sub: `${inv.branch.name} · ${fmtDate(inv.issuedAt)}` };
}

// For orders paid before invoices existed
async function generateInvoice(orderId) {
    const { ok, data } = await api(`/orders/${orderId}/invoice`, 'POST');
    if (!ok) { toast(data.error || 'The invoice could not be generated.', 'err'); return; }
    toast(data.created ? `Invoice ${data.number} generated.` : `The order already had invoice ${data.number}.`);
    go('invoice', { id: data.id });
}
