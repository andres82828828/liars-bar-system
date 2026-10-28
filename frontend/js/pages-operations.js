'use strict';
// =====================================================================
//  OPERATIONS: home, tables (create orders), order list and order detail
//  Waiter work — available to Waiter, Cashier and Administrator (HU-030)
// =====================================================================

// =====================================================================
//  HOME
// =====================================================================
async function pHome() {
    const first = esc(S.user.name.split(' ')[0]);
    const buttons = [`<button class="btn" onclick="go('tables')">＋ New order</button>`];
    if (canCharge()) buttons.push(`<button class="btn btn-ok" onclick="go('cash')"><i class="fa-solid fa-money-bill-wave"></i> Cash desk</button>`);
    if (canCharge()) buttons.push(`<button class="btn btn-ghost" onclick="go('report')"><i class="fa-solid fa-chart-line"></i> Sales report</button>`);
    else buttons.push(`<button class="btn btn-ghost" onclick="go('orders')">View orders</button>`);

    const head = `<section class="card welcome">
        <div><h2>Hello, ${first} <i class="fa-solid fa-hand"></i></h2><p>${esc(S.user.role)} · ${esc(branchName())}</p></div>
        <div class="btn-row">${buttons.join('')}</div></section>`;
    if (!S.branchId) return head + noBranch();

    const [t, o, i] = await Promise.all([api(`/tables?${bq()}`), api(`/orders?${bq()}&status=open`), api(`/inventory?${bq()}`)]);
    const tables = t.ok ? t.data : [], open = o.ok ? o.data : [], inv = i.ok ? i.data : [];
    const free = tables.filter(x => x.status === 'available').length;
    const low = inv.filter(x => x.active && x.quantity <= LOW_STOCK).sort((a, b) => a.quantity - b.quantity);

    const stats = `<div class="stats">
        <div class="card stat"><div class="stat-ico g"><i class="fa-solid fa-chair"></i></div><div><div class="stat-num">${free} <small>/ ${tables.length}</small></div><div class="stat-lbl">Available tables</div></div></div>
        <div class="card stat"><div class="stat-ico r"><i class="fa-solid fa-utensils"></i></div><div><div class="stat-num">${tables.filter(x => x.status === 'occupied').length}</div><div class="stat-lbl">Occupied tables</div></div></div>
        <div class="card stat"><div class="stat-ico y"><i class="fa-solid fa-clipboard-list"></i></div><div><div class="stat-num">${open.length}</div><div class="stat-lbl">Open orders</div></div></div>
        <div class="card stat"><div class="stat-ico b"><i class="fa-solid fa-boxes-stacked"></i></div><div><div class="stat-num">${low.length}</div><div class="stat-lbl">Products with low stock</div></div></div>
    </div>`;

    const orderRows = open.length ? open.slice(0, 8).map(x => `<tr>
        <td><b>Table #${x.table}</b><br><small>${esc(x.code)}</small></td><td>${fmtTime(x.createdAt)}</td>
        <td class="num">${money(x.total)}</td><td class="act"><button class="btn btn-sm btn-dark" onclick="go('order',{id:${x.id}})">Open</button></td></tr>`).join('')
        : `<tr><td colspan="4" class="empty">There are no open orders.</td></tr>`;

    const stockRows = low.length ? low.slice(0, 8).map(x => `<tr><td>${esc(x.name)}<br><small>${esc(x.type)}</small></td>
        <td class="num">${x.quantity === 0 ? '<span class="badge out">Out of stock</span>' : `<span class="badge low">${x.quantity} left</span>`}</td></tr>`).join('')
        : `<tr><td colspan="2" class="empty">All the inventory is at normal levels.</td></tr>`;

    return head + stats + `<div class="split even">
        <section class="card"><div class="card-head"><h3>Open orders</h3><button class="link-btn" onclick="go('orders')">View all <i class="fa-solid fa-arrow-right"></i></button></div>
            <div class="table-wrap"><table class="tbl"><tbody>${orderRows}</tbody></table></div></section>
        <section class="card"><div class="card-head"><h3>Low stock</h3><button class="link-btn" onclick="go('inventory')">Go to inventory <i class="fa-solid fa-arrow-right"></i></button></div>
            <div class="table-wrap"><table class="tbl"><tbody>${stockRows}</tbody></table></div></section>
    </div>`;
}

// =====================================================================
//  TABLES AND ORDER CREATION
// =====================================================================
async function pTables() {
    if (!S.branchId) return noBranch();
    const r = await api(`/tables?${bq()}`);
    if (!r.ok) return errCard(r.data.error);
    const tables = r.data;
    if (!tables.some(t => t.id === S.selTable && t.status === 'available')) S.selTable = null;

    if (!tables.length) {
        return `<div class="card empty"><span class="big"><i class="fa-solid fa-chair"></i></span>This branch has no tables yet.${isAdmin() ? '<br>Create them in <b>Branches &amp; tables</b>.' : ''}</div>`;
    }

    const cards = tables.map(t => {
        if (t.status === 'available') {
            return `<button class="table-card available ${S.selTable === t.id ? 'sel' : ''}" data-id="${t.id}" onclick="selectTable(${t.id},${t.number})">
                <span class="table-n">${t.number}</span><span class="table-s">Available</span></button>`;
        }
        if (t.status === 'inactive') {
            return `<div class="table-card inactive"><span class="table-n">${t.number}</span><span class="table-s">Inactive</span></div>`;
        }
        return `<div class="table-card occupied"><span class="table-n">${t.number}</span><span class="table-s">Occupied</span>
            ${t.orderId ? `<button class="btn btn-sm btn-dark" onclick="go('order',{id:${t.orderId}})">Open order</button><small>${esc(t.orderCode)}</small>` : ''}</div>`;
    }).join('');

    const free = tables.filter(t => t.status === 'available').length;
    return `<div class="action-bar" id="tableBar">${tableBarHTML()}</div>
        <section class="card">
            <div class="card-head"><h3>Tables of ${esc(branchName())}</h3><small>${free} available of ${tables.length}</small></div>
            <div class="legend"><span><i style="background:#43a047"></i>Available</span><span><i style="background:#e53935"></i>Occupied</span><span><i style="background:#9e9e9e"></i>Inactive</span></div>
            <div class="tables">${cards}</div>
        </section>`;
}

const tableBarHTML = () => S.selTable
    ? `<span>Table <b>#${S.selTableNum}</b> selected</span><button class="btn" id="btnCreateOrder" onclick="createOrder()">Create order</button>`
    : `<span>Tap an <b>available</b> table to start an order</span>`;

function selectTable(id, num) {
    S.selTable = id; S.selTableNum = num;
    $$('.table-card.available').forEach(b => b.classList.toggle('sel', Number(b.dataset.id) === id));
    const bar = $('#tableBar'); if (bar) bar.innerHTML = tableBarHTML();
}

async function createOrder() {
    if (!S.selTable) { toast('Select an available table.', 'warn'); return; }
    const btn = $('#btnCreateOrder'); if (btn) btn.disabled = true;
    const { ok, data } = await api('/orders', 'POST', { tableId: S.selTable });
    S.selTable = null;
    if (!ok) { toast(data.error || 'The order could not be created.', 'err'); go('tables'); return; }
    toast(`Order ${data.code} created · Table #${data.table} occupied`);
    go('order', { id: data.id });
}

// =====================================================================
//  ORDER LIST
// =====================================================================
async function pOrders() {
    if (!S.branchId) return noBranch();
    const st = S.statusFilter;
    const r = await api(`/orders?${bq()}${st ? `&status=${st}` : ''}`);
    if (!r.ok) return errCard(r.data.error);

    const chips = [['', 'All'], ['open', 'Open'], ['closed', 'Closed (paid)'], ['cancelled', 'Cancelled']]
        .map(([v, l]) => `<button class="fchip ${st === v ? 'active' : ''}" onclick="setStatusFilter('${v}')">${l}</button>`).join('');

    const rows = r.data.map(x => `<tr>
        <td><b>${esc(x.code)}</b></td><td>Table #${x.table}</td><td>${fmtDate(x.createdAt)}</td>
        <td>${statusBadge(x.status)}</td><td class="num"><b>${money(x.total)}</b></td>
        <td class="act"><button class="btn btn-sm btn-dark" onclick="go('order',{id:${x.id}})">View detail</button></td></tr>`).join('');

    return `<section class="card">
        <div class="card-head"><div class="filters">${chips}</div><small>${r.data.length} order(s) · ${esc(branchName())}</small></div>
        ${r.data.length
            ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Code</th><th>Table</th><th>Date and time</th><th>Status</th><th class="num">Total</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
            : `<div class="empty"><span class="big"><i class="fa-solid fa-clipboard-list"></i></span>There are no orders to show.</div>`}
    </section>`;
}
function setStatusFilter(v) { S.statusFilter = v; go('orders'); }

// =====================================================================
//  ORDER DETAIL + ADD PRODUCTS
// =====================================================================
async function pOrder() {
    const r = await api(`/orders/${S.params.id}`);
    if (!r.ok) return errCard(r.data.error);
    const o = r.data;
    const open = o.status === 'open';

    S.catalog = [];
    if (open) {
        const c = await api(`/catalog?branch_id=${o.branchId}`);
        S.catalog = c.ok ? sortList(c.data) : [];
    }

    // RF-48: while the order is open the Administrator and the Cashier can remove products
    // (the units go back to the inventory). The Waiter only adds.
    const canRemove = open && canCharge();
    const rows = o.items.map(i => `<tr>
        <td>${esc(i.name)}<br><small>${esc(i.code)}</small></td><td class="num">${i.quantity}</td>
        <td class="num">${money(i.price)}</td><td class="num"><b>${money(i.subtotal)}</b></td>
        ${canRemove ? `<td class="act"><button class="btn btn-sm btn-danger" title="Remove from the order" onclick="removeItem(${i.productId})"><i class="fa-solid fa-trash"></i></button></td>` : ''}</tr>`).join('');

    // After the payment the order is CLOSED: no more products, the table is available and it has an invoice
    let footer = '';
    if (o.status === 'closed') {
        footer = `<p class="hint"><i class="fa-solid fa-lock"></i> This order is closed: it was paid, the table was released and it can no longer be modified.</p>`;
    } else if (canRemove && o.items.length) {
        footer = '<p class="hint"><i class="fa-solid fa-circle-info"></i> Removed products go back to the branch inventory.</p>';
    } else if (open && o.items.length) {
        footer = '<p class="hint"><i class="fa-solid fa-lock"></i> Only the cashier or the administrator can remove products from the order.</p>';
    }

    const invoiceBtn = o.status === 'closed' && canCharge()
        ? (o.invoice
            ? `<button class="btn btn-dark" onclick="go('invoice',{id:${o.invoice.id}})"><i class="fa-solid fa-receipt"></i> View invoice ${esc(o.invoice.number)}</button>`
            : `<button class="btn" onclick="generateInvoice(${o.id})"><i class="fa-solid fa-receipt"></i> Generate invoice</button>`)
        : '';

    const ticket = `<section class="card">
        <div class="ticket-head"><div><small>ORDER</small><h3>${esc(o.code)}</h3></div>${statusBadge(o.status)}</div>
        <div class="ticket-meta">
            <div><span>Table</span><b>#${o.table}</b></div><div><span>Branch</span><b>${esc(o.branch)}</b></div>
            <div><span>Opened</span><b>${fmtDate(o.createdAt)}</b></div>
            <div><span>${o.status === 'cancelled' ? 'Cancelled' : 'Closed'}</span><b>${o.closedAt ? fmtDate(o.closedAt) : '—'}</b></div>
        </div>
        ${o.items.length
            ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Subtotal</th>${canRemove ? '<th></th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>`
            : `<div class="empty"><span class="big"><i class="fa-solid fa-cart-shopping"></i></span>There are no products in this order yet.</div>`}
        ${footer}
        <div class="ticket-total"><span>Total</span><strong>${money(o.total)}</strong></div>
        ${o.payment ? paymentInfoHTML(o.payment) : ''}
        <div class="btn-row" style="margin-top:18px">
            <button class="btn btn-ghost" onclick="go('${open ? 'tables' : 'orders'}')"><i class="fa-solid fa-arrow-left"></i> Back</button>
            ${open && !o.items.length && canCharge() ? `<button class="btn btn-danger" onclick="cancelOrder()">Cancel empty order</button>` : ''}
            ${open && o.items.length && canCharge() ? `<button class="btn btn-ok" onclick="go('checkout',{id:${o.id}})"><i class="fa-solid fa-money-bill-wave"></i> Charge order</button>` : ''}
            ${invoiceBtn}
        </div>
    </section>`;

    const meta = { title: 'Order · Table #' + o.table, sub: `${o.branch} · ${fmtDate(o.createdAt)}` };
    if (!open) return { html: ticket, ...meta };

    const catalog = `<section class="card">
        <div class="card-head"><h3>Available catalog</h3>
            <input class="search" id="catSearch" placeholder="Search product…" oninput="filterRows(this.value,'#catList .cat-row')"></div>
        ${S.catalog.length ? sortToolbar() : ''}
        <div class="cat-list" id="catList">${S.catalog.length ? S.catalog.map(catalogRow).join('')
            : `<div class="empty"><span class="big"><i class="fa-solid fa-boxes-stacked"></i></span>There are no products with stock in this branch.<br>Stock must be added to the inventory.</div>`}</div>
    </section>`;

    return { html: `<div class="split">${catalog}${ticket}</div>`, ...meta };
}

// Removes units of a product from the open order. With more than one unit it asks how many.
async function removeItem(productId) {
    const r0 = await api(`/orders/${S.params.id}`);
    const item = r0.ok ? r0.data.items.find(i => i.productId === productId) : null;
    if (!item) { toast('That product is no longer in the order.', 'warn'); go('order', S.params); return; }
    let quantity = item.quantity;
    if (item.quantity > 1) {
        const v = prompt(`How many units of "${item.name}" do you want to remove? (1 to ${item.quantity})`, String(item.quantity));
        if (v === null) return;
        quantity = Number(v);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > item.quantity) {
            toast(`Enter a whole number between 1 and ${item.quantity}.`, 'warn'); return;
        }
    } else if (!confirm(`Remove "${item.name}" from the order?`)) return;
    const r = await api(`/orders/${S.params.id}/items/${productId}`, 'DELETE', { quantity });
    if (!r.ok) { toast(r.data.error || 'The product could not be removed.', 'err'); return; }
    toast(`Removed ${quantity} × ${item.name}. The units went back to the inventory.`);
    go('order', S.params);
}

function catalogRow(x) {
    return `<div class="cat-row" data-q="${esc((x.name + ' ' + x.type + ' ' + x.code).toLowerCase())}">
        <div class="cat-info"><strong>${esc(x.name)}</strong><small>${esc(x.type)} · ${esc(x.code)}</small></div>
        <div class="cat-price">${money(x.price)}<small>Available: ${x.quantity}</small></div>
        <div class="cat-add">
            <input type="number" id="qty-${x.id}" min="1" max="${x.quantity}" step="1" value="1" oninput="calcSubtotal(${x.id})">
            <span class="sub" id="sub-${x.id}">${money(x.price)}</span>
            <button class="btn btn-sm" onclick="addItem(${x.id})">Add</button>
        </div></div>`;
}

function calcSubtotal(id) {
    const x = S.catalog.find(c => c.id === id), out = $('#sub-' + id), q = parseInt($('#qty-' + id).value, 10);
    if (!x || !out) return;
    if (!Number.isInteger(q) || q < 1) { out.textContent = '—'; out.classList.remove('over'); return; }
    out.textContent = money(q * x.price);
    out.classList.toggle('over', q > x.quantity);
}

async function addItem(id) {
    const x = S.catalog.find(c => c.id === id);
    const q = Number($('#qty-' + id).value);
    if (!Number.isInteger(q) || q < 1) { toast('The quantity must be a whole number greater than 0.', 'warn'); return; }
    if (q > x.quantity) { toast(`Not enough stock: there are only ${x.quantity} units of "${x.name}".`, 'err'); return; }

    const { ok, data } = await api(`/orders/${S.params.id}/items`, 'POST', { productId: id, quantity: q });
    if (!ok) toast(data.error || 'The product could not be added.', 'err');
    else toast(`${q} × ${x.name} added to the order`);
    go('order', S.params);
}

async function cancelOrder() {
    if (!confirm('Cancel this empty order?\nThe table will be available again.')) return;
    const { ok, data } = await api(`/orders/${S.params.id}/cancel`, 'POST');
    if (!ok) { toast(data.error || 'It could not be cancelled.', 'err'); return; }
    toast('Order cancelled. The table is available.');
    go('tables');
}

// Payment summary of a closed order
function paymentInfoHTML(p) {
    const m = PAYMENT_METHODS[p.method] || { name: p.method, icon: '<i class="fa-solid fa-sack-dollar"></i>' };
    const cash = p.method === 'cash';
    if (p.status === 'pending') {
        return `<div class="ticket-meta payment-info">
            <div><span>Payment method</span><b>${m.icon} ${esc(m.name)}</b></div>
            <div><span>Status</span><b><span class="badge warn">Pending collection</span></b></div>
            <div><span>Deferred at</span><b>${fmtDate(p.paidAt)}</b></div>
            <div><span>Amount due</span><b>${money(p.amountPaid)}</b></div>
            ${p.cashier ? `<div class="full"><span>Registered by</span><b>${esc(p.cashier)}</b></div>` : ''}
        </div>`;
    }
    return `<div class="ticket-meta payment-info">
        <div><span>Payment method</span><b>${m.icon} ${esc(m.name)}</b></div>
        <div><span>Paid at</span><b>${fmtDate(p.paidAt)}</b></div>
        <div><span>Amount received</span><b>${money(p.amountReceived ?? p.amountPaid)}</b></div>
        <div><span>Change</span><b>${cash ? money(p.change) : 'N/A'}</b></div>
        ${p.cashier ? `<div class="full"><span>Charged by</span><b>${esc(p.cashier)}</b></div>` : ''}
        ${cash && p.change > 0 ? `<div class="full breakdown">${breakdownHTML(p.change)}</div>` : ''}
    </div>`;
}
