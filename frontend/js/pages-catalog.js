'use strict';
// =====================================================================
//  CATALOG AND INVENTORY
//  Inventory: everyone looks · Administrator and Cashier add stock ·
//  Administrator activates / deactivates per branch. Products, types, suppliers: Administrator.
// =====================================================================

// =====================================================================
//  INVENTORY
// =====================================================================
async function pInventory() {
    if (!S.branchId) return noBranch();
    const r = await api(`/inventory?${bq()}`);
    if (!r.ok) return errCard(r.data.error);
    const inv = r.data;
    S.inventory = inv;

    // Availability in the branch (HU-020): not assigned / inactive (admin decision) / out of stock / low / available
    const badge = (x) => !x.assigned ? '<span class="badge gray">Not assigned</span>'
        : !x.active ? '<span class="badge inactive">Inactive</span>'
        : x.quantity === 0 ? '<span class="badge out">Out of stock</span>'
        : x.quantity <= LOW_STOCK ? '<span class="badge low">Low</span>' : '<span class="badge available">Available</span>';

    const action = (x) => !isAdmin() ? ''
        : `<td class="act">${x.active
            ? `<button class="btn btn-sm btn-danger" onclick="setAvailability(${x.id},false)">Deactivate</button>`
            : `<button class="btn btn-sm btn-ok" onclick="setAvailability(${x.id},true)">${x.assigned ? 'Activate' : 'Assign & activate'}</button>`}</td>`;

    const rows = inv.map(x => `<tr class="stock-row" data-q="${esc((x.name + ' ' + x.code + ' ' + x.type).toLowerCase())}">
        <td>${esc(x.code)}</td><td><b>${esc(x.name)}</b></td><td>${esc(x.type)}</td>
        <td class="num"><b>${x.quantity}</b></td><td>${badge(x)}</td>${action(x)}</tr>`).join('');

    const active = inv.filter(x => x.active).length;
    const inactive = inv.filter(x => x.assigned && !x.active).length;
    const unassigned = inv.filter(x => !x.assigned).length;

    const table = `<section class="card">
        <div class="card-head"><h3>Products per branch · ${esc(branchName())}</h3>
            <input class="search" placeholder="Search product…" oninput="filterRows(this.value,'.stock-row')"></div>
        ${inv.length ? `<p class="hint" style="margin:-6px 0 12px">${active} active · ${inactive} inactive · ${unassigned} not assigned.
            Only <b>active</b> products with stock appear in the order catalog.</p>` : ''}
        ${inv.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Code</th><th>Product</th><th>Type</th><th class="num">Units</th><th>Status</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>`
            : `<div class="empty"><span class="big"><i class="fa-solid fa-boxes-stacked"></i></span>There are no products yet.${isAdmin() ? '<br><button class="btn btn-sm" style="margin-top:10px" onclick="go(\'products\')">Create products</button>' : ''}</div>`}
    </section>`;

    if (!canStock()) return table;

    const form = `<section class="card">
        <div class="card-head"><h3>Add stock</h3></div>
        <p class="hint" style="margin:-6px 0 14px">Branch: <b>${esc(branchName())}</b>. The units are <b>added</b> to the current stock.</p>
        <div class="field"><label>Product *</label>
            <select id="stockProduct">${inv.map(x => `<option value="${x.id}">${esc(x.code)} — ${esc(x.name)} (${x.quantity} in stock)${x.assigned && !x.active ? ' · INACTIVE' : ''}</option>`).join('')}</select></div>
        <div class="field"><label>Quantity to add (units) *</label>
            <input type="number" id="stockQty" min="1" step="1" placeholder="e.g. 24"><span class="hint">Whole number greater than 0.</span></div>
        <button class="btn btn-block" onclick="addStock()" ${inv.length ? '' : 'disabled'}>Register entry</button>
    </section>`;

    return `<div class="split">${table}${form}</div>`;
}

async function addStock() {
    const productId = Number($('#stockProduct').value);
    const raw = $('#stockQty').value.trim();
    const quantity = Number(raw);
    if (!productId) { toast('Select the product.', 'warn'); return; }
    if (raw === '' || !Number.isInteger(quantity) || quantity < 1) { toast('The quantity must be a whole number greater than 0.', 'warn'); return; }
    if (quantity > 100000) { toast('The maximum quantity per entry is 100000.', 'warn'); return; }

    const { ok, data } = await api('/inventory', 'POST', { branchId: S.branchId, productId, quantity });
    if (!ok) { toast(data.error || 'The entry could not be registered.', 'err'); return; }
    if (data.active) toast(`Entry registered. There are now ${data.quantity} units.`);
    else toast(`Entry registered (${data.quantity} units), but the product is INACTIVE in this branch: it will not be sold until ${isAdmin() ? 'you activate it' : 'the administrator activates it'}.`, 'warn');
    go('inventory');
}

// Activates or deactivates a product in the current branch (Administrator only)
async function setAvailability(productId, active) {
    const x = S.inventory.find(p => p.id === productId);
    const name = x ? x.name : 'the product';
    if (!active && !confirm(`Deactivate "${name}" in ${branchName()}?\nIt will no longer appear in this branch's order catalog (its units are kept).`)) return;
    const { ok, data } = await api('/inventory/availability', 'PATCH', { branchId: S.branchId, productId, active });
    if (!ok) { toast(data.error || 'The availability could not be changed.', 'err'); return; }
    toast(active
        ? `"${name}" is active in ${branchName()}${data.quantity ? '' : ' (no units: add stock to sell it)'}.`
        : `"${name}" deactivated in ${branchName()}.`, active && !data.quantity ? 'warn' : 'ok');
    go('inventory');
}

// =====================================================================
//  PRODUCTS (Administrator)
// =====================================================================
async function pProducts() {
    const [rp, rt, rs] = await Promise.all([api('/products'), api('/product-types'), api('/suppliers')]);
    if (!rp.ok) return errCard(rp.data.error);
    S.products = rp.data; S.types = rt.data || [];
    const suppliers = rs.data || [];

    const editing = S.products.find(p => p.id === S.editProduct);
    if (S.editProduct && !editing) S.editProduct = null;
    const f = S.draftProduct || (editing ? {
        code: editing.code, name: editing.name, typeId: editing.typeId, supplierId: editing.supplierId,
        purchasePrice: editing.purchasePrice, salePrice: editing.salePrice } : {});
    S.draftProduct = null;

    const notice = !S.types.length
        ? `<div class="notice"><i class="fa-solid fa-triangle-exclamation"></i> First create at least one <b>product type</b>. <button class="link-btn" onclick="go('types')">Go to Product types <i class="fa-solid fa-arrow-right"></i></button></div>` : '';

    const form = `<section class="card">
        <div class="card-head"><h3>${editing ? 'Edit product' : 'Register product'}</h3></div>
        ${notice}
        <div class="row2">
            <div class="field"><label>Code *</label><input id="pCode" value="${esc(f.code || '')}" placeholder="e.g. LIC-002" maxlength="50"></div>
            <div class="field"><label>Name *</label><input id="pName" value="${esc(f.name || '')}" placeholder="e.g. Aged Rum" maxlength="100"></div>
        </div>
        <div class="field"><label>Product type *</label>
            <select id="pType">${optionsHTML(S.types, f.typeId, 'Select type…')}</select></div>
        <div class="field"><label>Supplier *</label>
            <select id="pSupplier">${optionsHTML(suppliers, f.supplierId, 'Select supplier…')}</select>
            <button class="link-btn" type="button" onclick="$('#supplierRow').hidden=!$('#supplierRow').hidden">＋ New supplier</button>
            <div class="inline-add" id="supplierRow" ${suppliers.length ? 'hidden' : ''}>
                <input id="supplierNew" placeholder="Supplier name" maxlength="100">
                <button class="btn btn-sm btn-dark" type="button" onclick="newSupplier()">Save</button></div></div>
        <div class="row2">
            <div class="field"><label>Purchase price *</label><input type="number" id="pPurchase" min="0" step="100" value="${f.purchasePrice ?? ''}" oninput="updateMargin()" placeholder="0"></div>
            <div class="field"><label>Sale price *</label><input type="number" id="pSale" min="0" step="100" value="${f.salePrice ?? ''}" oninput="updateMargin()" placeholder="0"></div>
        </div>
        <span class="hint" style="margin:-8px 0 10px">The sale price must be equal to or greater than the purchase price.</span>
        <div class="margin" id="pMargin">Margin: —</div>
        <div class="btn-row">
            <button class="btn" onclick="saveProduct()">${editing ? 'Save changes' : 'Save product'}</button>
            ${editing ? '<button class="btn btn-ghost" onclick="cancelProductEdit()">Cancel edit</button>' : ''}
        </div>
    </section>`;

    const table = `<section class="card">
        <div class="card-head"><h3>Product catalog</h3>
            <input class="search" id="prodSearch" placeholder="Search…" oninput="filterRows(this.value,'.prod-row')"></div>
        ${S.products.length ? sortToolbar() : ''}
        ${S.products.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Code</th><th>Product</th><th>Type</th><th>Supplier</th><th class="num">Purchase</th><th class="num">Sale</th><th></th></tr></thead><tbody id="prodBody">${productRows()}</tbody></table></div>`
            : `<div class="empty"><span class="big"><i class="fa-solid fa-martini-glass-citrus"></i></span>There are no products yet. Register the first one.</div>`}
    </section>`;

    return `<div class="split" style="grid-template-columns:minmax(0,1fr) minmax(0,1.5fr)">${form}${table}</div>`;
}

// Product table rows, sorted with the chosen method
function productRows() {
    return sortList(S.products).map(p => `<tr class="prod-row" data-q="${esc((p.name + ' ' + p.code + ' ' + p.type + ' ' + p.supplier + ' ' + p.branches).toLowerCase())}">
        <td>${esc(p.code)}</td><td><b>${esc(p.name)}</b><br><small>${p.branches ? '<i class="fa-solid fa-location-dot"></i> ' + esc(p.branches) : 'Not active in any branch'}</small></td>
        <td>${esc(p.type)}</td><td>${esc(p.supplier)}</td>
        <td class="num">${money(p.purchasePrice)}</td><td class="num"><b>${money(p.salePrice)}</b></td>
        <td class="act"><button class="btn btn-sm btn-ghost" onclick="editProduct(${p.id})">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteProduct(${p.id})">Delete</button></td></tr>`).join('');
}

function updateMargin() {
    const el = $('#pMargin'); if (!el) return;
    const c = Number($('#pPurchase').value), v = Number($('#pSale').value);
    el.classList.remove('bad');
    if (!(v > 0)) { el.textContent = 'Margin: —'; return; }
    const g = v - c;
    if (g < 0) {      // sale price below the purchase price: it cannot be saved
        el.classList.add('bad');
        el.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> The sale price cannot be lower than the purchase price (it is ${money(-g)} below cost).`;
        return;
    }
    el.textContent = `Margin: ${money(g)}${c > 0 ? ` (${Math.round(g / c * 100)}% over cost)` : ''}`;
}

function readProductForm() {
    const v = (id) => ($('#' + id) || {}).value || '';
    return { code: v('pCode').trim(), name: v('pName').trim(), typeId: v('pType'), supplierId: v('pSupplier'),
             purchasePrice: v('pPurchase'), salePrice: v('pSale') };
}

async function newSupplier() {
    const name = $('#supplierNew').value.trim();
    if (!name) { toast('Type the supplier name.', 'warn'); return; }
    const { ok, data } = await api('/suppliers', 'POST', { name });
    if (!ok) { toast(data.error || 'The supplier could not be created.', 'err'); return; }
    toast(`Supplier "${name}" created.`);
    S.draftProduct = { ...readProductForm(), supplierId: String(data.id) };   // keeps what was already typed
    go('products');
}

async function saveProduct() {
    const f = readProductForm();
    if (!f.code || !f.name) { toast('The code and the name are required.', 'warn'); return; }
    if (!f.typeId) { toast('Select the product type.', 'warn'); return; }
    if (!f.supplierId) { toast('Select the supplier.', 'warn'); return; }
    if (f.purchasePrice === '' || f.salePrice === '') { toast('Enter the purchase price and the sale price.', 'warn'); return; }
    const purchase = Number(f.purchasePrice), sale = Number(f.salePrice);
    if (!Number.isFinite(purchase) || purchase < 0) { toast('The purchase price must be a valid number (0 or more).', 'warn'); return; }
    if (!Number.isFinite(sale) || sale <= 0) { toast('The sale price must be a number greater than 0.', 'warn'); return; }
    if (sale < purchase) { toast('The sale price cannot be lower than the purchase price.', 'err'); $('#pSale').focus(); return; }

    const body = { ...f, typeId: Number(f.typeId), supplierId: Number(f.supplierId), purchasePrice: purchase, salePrice: sale };
    const r = S.editProduct ? await api(`/products/${S.editProduct}`, 'PUT', body) : await api('/products', 'POST', body);
    if (!r.ok) { toast(r.data.error || 'The product could not be saved.', 'err'); return; }
    toast(S.editProduct ? 'Product updated.' : 'Product saved. You can now add stock for it.');
    S.editProduct = null;
    go('products');
}

function editProduct(id) { S.editProduct = id; go('products'); }
function cancelProductEdit() { S.editProduct = null; go('products'); }

async function deleteProduct(id) {
    const p = S.products.find(x => x.id === id);
    if (!confirm(`Delete the product "${p ? p.name : ''}"?`)) return;
    const { ok, status, data } = await api(`/products/${id}`, 'DELETE');
    if (status === 409) { notice('This product cannot be deleted', data.error); return; }
    if (!ok) { toast(data.error || 'It could not be deleted.', 'err'); return; }
    toast('Product deleted.');
    go('products');
}

// =====================================================================
//  PRODUCT TYPES AND SUPPLIERS (Administrator) — same simple "name" screen
// =====================================================================
function nameCatalogPage({ list, editingId, page, label, placeholder, maxLen, usageHead, usageText, icon, saveFn, delFn, editVar, search }) {
    const editing = list.find(x => x.id === editingId);
    const form = `<section class="card">
        <div class="card-head"><h3>${editing ? 'Edit ' + label : 'Register ' + label}</h3></div>
        <div class="field"><label>${label[0].toUpperCase() + label.slice(1)} name *</label>
            <input id="catName" value="${esc(editing ? editing.name : '')}" placeholder="${placeholder}" maxlength="${maxLen}"
                   onkeydown="if(event.key==='Enter')${saveFn}()"></div>
        <div class="btn-row">
            <button class="btn" onclick="${saveFn}()">${editing ? 'Save changes' : 'Save ' + label}</button>
            ${editing ? `<button class="btn btn-ghost" onclick="S.${editVar}=null;go('${page}')">Cancel edit</button>` : ''}
        </div>
    </section>`;

    const rows = list.map(x => `<tr class="name-row" data-q="${esc(x.name.toLowerCase())}"><td><b>${esc(x.name)}</b></td>
        <td class="num">${x.products} ${usageText}</td>
        <td class="act"><button class="btn btn-sm btn-ghost" onclick="S.${editVar}=${x.id};go('${page}')">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="${delFn}(${x.id})">Delete</button></td></tr>`).join('');

    const table = `<section class="card"><div class="card-head"><h3>Registered</h3>
            ${search ? `<input class="search" placeholder="Search…" oninput="filterRows(this.value,'.name-row')">` : `<small>${list.length} item(s)</small>`}</div>
        ${list.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>${label}</th><th class="num">${usageHead}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
            : `<div class="empty"><span class="big">${icon}</span>Nothing registered yet.</div>`}</section>`;

    return `<div class="split even">${form}${table}</div>`;
}

async function saveNamed(route, editVar, page, label) {
    const name = $('#catName').value.trim();
    if (!name) { toast(`The ${label} name is required.`, 'warn'); return; }
    const id = S[editVar];
    const r = id ? await api(`/${route}/${id}`, 'PUT', { name }) : await api(`/${route}`, 'POST', { name });
    if (!r.ok) { toast(r.data.error || `The ${label} could not be saved.`, 'err'); return; }
    toast(id ? `${label[0].toUpperCase() + label.slice(1)} updated.` : `${label[0].toUpperCase() + label.slice(1)} "${name}" created.`);
    S[editVar] = null;
    go(page);
}

async function deleteNamed(route, list, id, page, label) {
    const x = list.find(v => v.id === id);
    if (!confirm(`Delete the ${label} "${x ? x.name : ''}"?`)) return;
    const { ok, status, data } = await api(`/${route}/${id}`, 'DELETE');
    if (status === 409) { notice(`This ${label} cannot be deleted`, data.error); return; }
    if (!ok) { toast(data.error || 'It could not be deleted.', 'err'); return; }
    toast(`${label[0].toUpperCase() + label.slice(1)} deleted.`);
    go(page);
}

async function pTypes() {
    const r = await api('/product-types');
    if (!r.ok) return errCard(r.data.error);
    S.types = r.data;
    if (S.editType && !S.types.some(t => t.id === S.editType)) S.editType = null;
    return nameCatalogPage({ list: S.types, editingId: S.editType, page: 'types', label: 'product type', maxLen: 50,
        placeholder: 'e.g. Whisky, Desserts, Non-alcoholic', usageHead: 'Usage', usageText: 'product(s)', icon: '<i class="fa-solid fa-tags"></i>',
        saveFn: 'saveType', delFn: 'deleteType', editVar: 'editType' });
}
const saveType = () => saveNamed('product-types', 'editType', 'types', 'product type');
const deleteType = (id) => deleteNamed('product-types', S.types, id, 'types', 'product type');

async function pSuppliers() {
    const r = await api('/suppliers');
    if (!r.ok) return errCard(r.data.error);
    S.suppliers = r.data;
    if (S.editSupplier && !S.suppliers.some(s => s.id === S.editSupplier)) S.editSupplier = null;
    return nameCatalogPage({ list: S.suppliers, editingId: S.editSupplier, page: 'suppliers', label: 'supplier', maxLen: 100,
        placeholder: 'e.g. Distribuidora Andina', usageHead: 'Supplies', usageText: 'product(s)', icon: '<i class="fa-solid fa-truck"></i>',
        saveFn: 'saveSupplier', delFn: 'deleteSupplier', editVar: 'editSupplier', search: true });
}
const saveSupplier = () => saveNamed('suppliers', 'editSupplier', 'suppliers', 'supplier');
const deleteSupplier = (id) => deleteNamed('suppliers', S.suppliers, id, 'suppliers', 'supplier');
