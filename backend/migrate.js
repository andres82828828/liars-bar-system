// =====================================================================
//  Schema migration (keeps all data)
//  The current schema uses the Spanish names of the entity-relationship model
//  (sede, mesa, usuario, pedido, detalle_factura…). Older databases are brought to it:
//  1) First Spanish version (sede without "activo", values 'libre', 'Administrador'…):
//     translated to the English schema of the intermediate versions.
//  2) English schema (branch, bar_table, customer_order…): missing columns are added
//     and then tables, columns, constraints and sequences are renamed to Spanish.
//  3) The audit trail trigger is checked (safe to run many times).
//  Everything runs in ONE transaction: all or nothing.
//
//  Runs automatically when the server starts, or manually: npm run migrate
// =====================================================================

const TABLES = [
  ['sede', 'branch'], ['mesa', 'bar_table'], ['usuario', 'app_user'], ['log_trazabilidad', 'audit_log'],
  ['proveedor', 'supplier'], ['tipo_producto', 'product_type'], ['producto', 'product'],
  ['producto_sede', 'product_branch'], ['pedido', 'customer_order'], ['detalle_pedido', 'order_detail'],
  ['pago', 'payment'], ['factura', 'invoice']
];

const COLUMNS = {
  branch:         [['id_sede', 'branch_id'], ['nombre', 'name'], ['direccion', 'address']],
  bar_table:      [['id_mesa', 'table_id'], ['id_sede', 'branch_id'], ['numero', 'number'], ['estado', 'status']],
  app_user:       [['id_usuario', 'user_id'], ['id_sede', 'branch_id'], ['nombre_completo', 'full_name'], ['rol', 'role'],
                   ['activo', 'active'], ['intentos_fallidos', 'failed_attempts'], ['token_sesion', 'session_token'],
                   ['reset_autorizado_hasta', 'reset_authorized_until']],
  audit_log:      [['id_log', 'log_id'], ['id_usuario', 'user_id'], ['operacion', 'operation'], ['fecha_hora', 'created_at']],
  supplier:       [['id_proveedor', 'supplier_id'], ['nombre', 'name']],
  product_type:   [['id_tipo', 'type_id'], ['nombre', 'name']],
  product:        [['id_producto', 'product_id'], ['id_tipo', 'type_id'], ['id_proveedor', 'supplier_id'], ['codigo', 'code'],
                   ['nombre', 'name'], ['valor_compra', 'purchase_price'], ['valor_venta', 'sale_price']],
  product_branch: [['id_sede', 'branch_id'], ['id_producto', 'product_id'], ['cantidad_disponible', 'quantity'],
                   ['estado_disponibilidad', 'is_active']],
  customer_order: [['id_pedido', 'order_id'], ['id_mesa', 'table_id'], ['codigo_unico', 'unique_code'],
                   ['fecha_hora', 'created_at'], ['estado', 'status']],
  order_detail:   [['id_pedido', 'order_id'], ['id_producto', 'product_id'], ['cantidad', 'quantity'], ['valor_unitario', 'unit_price']],
  payment:        [['id_pago', 'payment_id'], ['id_pedido', 'order_id'], ['valor_pagado', 'amount_paid'],
                   ['valor_recibido', 'amount_received'], ['metodo_pago', 'method'], ['fecha_hora', 'paid_at'], ['cambio', 'change_amount']],
  invoice:        [['id_factura', 'invoice_id'], ['id_pedido', 'order_id'], ['id_pago', 'payment_id'], ['fecha_emision', 'issued_at']]
};

// Old CHECK constraints are dropped (they compare Spanish values) and recreated in English
const OLD_CHECKS = {
  bar_table: ['ck_mesa_estado'], app_user: ['ck_usuario_rol'], customer_order: ['ck_pedido_estado'],
  payment: ['ck_pago_metodo', 'ck_pago_valores'], product: ['ck_producto_valores', 'ck_producto_margen'],
  product_branch: ['ck_ps_cantidad'], order_detail: ['ck_dp_cantidad']
};

const CONSTRAINTS = [
  ['branch', 'sede_pkey', 'branch_pkey'], ['branch', 'sede_nombre_key', 'branch_name_key'],
  ['bar_table', 'mesa_pkey', 'bar_table_pkey'], ['bar_table', 'fk_mesa_sede', 'fk_table_branch'],
  ['bar_table', 'uq_mesa_sede_numero', 'uq_table_branch_number'],
  ['app_user', 'usuario_pkey', 'app_user_pkey'], ['app_user', 'usuario_username_key', 'app_user_username_key'],
  ['app_user', 'fk_usuario_sede', 'fk_user_branch'],
  ['audit_log', 'log_trazabilidad_pkey', 'audit_log_pkey'], ['audit_log', 'fk_log_usuario', 'fk_log_user'],
  ['supplier', 'proveedor_pkey', 'supplier_pkey'],
  ['product_type', 'tipo_producto_pkey', 'product_type_pkey'], ['product_type', 'tipo_producto_nombre_key', 'product_type_name_key'],
  ['product', 'producto_pkey', 'product_pkey'], ['product', 'producto_codigo_key', 'product_code_key'],
  ['product', 'fk_producto_tipo', 'fk_product_type'], ['product', 'fk_producto_proveedor', 'fk_product_supplier'],
  ['product_branch', 'producto_sede_pkey', 'product_branch_pkey'], ['product_branch', 'fk_ps_sede', 'fk_pb_branch'],
  ['product_branch', 'fk_ps_producto', 'fk_pb_product'],
  ['customer_order', 'pedido_pkey', 'customer_order_pkey'], ['customer_order', 'pedido_codigo_unico_key', 'customer_order_unique_code_key'],
  ['customer_order', 'fk_pedido_mesa', 'fk_order_table'],
  ['order_detail', 'detalle_pedido_pkey', 'order_detail_pkey'], ['order_detail', 'fk_dp_pedido', 'fk_od_order'],
  ['order_detail', 'fk_dp_producto', 'fk_od_product'],
  ['payment', 'pago_pkey', 'payment_pkey'], ['payment', 'pago_id_pedido_key', 'payment_order_id_key'],
  ['payment', 'fk_pago_pedido', 'fk_payment_order'],
  ['invoice', 'factura_pkey', 'invoice_pkey'], ['invoice', 'factura_id_pedido_key', 'invoice_order_id_key'],
  ['invoice', 'factura_id_pago_key', 'invoice_payment_id_key'], ['invoice', 'fk_factura_pedido', 'fk_invoice_order'],
  ['invoice', 'fk_factura_pago', 'fk_invoice_payment']
];

const SEQUENCES = [
  ['sede_id_sede_seq', 'branch_branch_id_seq'], ['mesa_id_mesa_seq', 'bar_table_table_id_seq'],
  ['usuario_id_usuario_seq', 'app_user_user_id_seq'], ['log_trazabilidad_id_log_seq', 'audit_log_log_id_seq'],
  ['proveedor_id_proveedor_seq', 'supplier_supplier_id_seq'], ['tipo_producto_id_tipo_seq', 'product_type_type_id_seq'],
  ['producto_id_producto_seq', 'product_product_id_seq'], ['pedido_id_pedido_seq', 'customer_order_order_id_seq'],
  ['pago_id_pago_seq', 'payment_payment_id_seq'], ['factura_id_factura_seq', 'invoice_invoice_id_seq']
];

async function exists(c, sql, params) {
  return (await c.query(sql, params)).rowCount > 0;
}
const tableExists = (c, t) => exists(c, 'SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = $1', [t]);
const columnExists = (c, t, col) => exists(c,
  'SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2', [t, col]);
const constraintExists = (c, name) => exists(c,
  'SELECT 1 FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = current_schema() AND k.conname = $1', [name]);

// Converts the old Spanish schema into the English one
async function fromSpanish(c) {
  // The old server added these columns on startup; make sure they exist before renaming
  await c.query('ALTER TABLE usuario ADD COLUMN IF NOT EXISTS reset_autorizado_hasta TIMESTAMP NULL');
  await c.query('ALTER TABLE pago ADD COLUMN IF NOT EXISTS valor_recibido DECIMAL(10,2) NULL');

  for (const [oldName, newName] of TABLES) await c.query(`ALTER TABLE ${oldName} RENAME TO ${newName}`);

  for (const [table, checks] of Object.entries(OLD_CHECKS)) {
    for (const ck of checks) await c.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${ck}`);
  }

  for (const [table, cols] of Object.entries(COLUMNS)) {
    for (const [oldCol, newCol] of cols) {
      if (await columnExists(c, table, oldCol)) await c.query(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
    }
  }

  // Status / role / method values
  await c.query(`UPDATE bar_table SET status = CASE status WHEN 'libre' THEN 'available' WHEN 'ocupada' THEN 'occupied' ELSE status END`);
  await c.query(`UPDATE app_user SET role = CASE role WHEN 'Administrador' THEN 'Administrator' WHEN 'Cajero' THEN 'Cashier'
                                                       WHEN 'Mesero' THEN 'Waiter' ELSE role END`);
  await c.query(`UPDATE customer_order SET status = CASE status WHEN 'abierto' THEN 'open' WHEN 'pagado' THEN 'closed'
                                                               WHEN 'cancelado' THEN 'cancelled' ELSE status END`);
  await c.query(`UPDATE payment SET method = CASE method WHEN 'efectivo' THEN 'cash' WHEN 'tarjeta_credito' THEN 'credit_card'
                                                          WHEN 'tarjeta_debito' THEN 'debit_card' ELSE method END`);
  await c.query(`ALTER TABLE bar_table ALTER COLUMN status SET DEFAULT 'available'`);
  await c.query(`ALTER TABLE customer_order ALTER COLUMN status SET DEFAULT 'open'`);

  for (const [table, oldName, newName] of CONSTRAINTS) {
    if (await constraintExists(c, oldName)) await c.query(`ALTER TABLE ${table} RENAME CONSTRAINT ${oldName} TO ${newName}`);
  }
  await c.query('ALTER INDEX IF EXISTS idx_log_usuario_fecha RENAME TO idx_log_user_date');
  for (const [oldName, newName] of SEQUENCES) await c.query(`ALTER SEQUENCE IF EXISTS ${oldName} RENAME TO ${newName}`);

  // New English CHECK constraints. The margin rule is NOT VALID: it applies to new/edited
  // products without failing if an old product was saved below cost.
  await c.query(`ALTER TABLE bar_table ADD CONSTRAINT ck_table_status CHECK (status IN ('available','occupied'))`);
  await c.query(`ALTER TABLE app_user ADD CONSTRAINT ck_user_role CHECK (role IN ('Administrator','Cashier','Waiter'))`);
  await c.query(`ALTER TABLE customer_order ADD CONSTRAINT ck_order_status CHECK (status IN ('open','closed','cancelled'))`);
  await c.query(`ALTER TABLE payment ADD CONSTRAINT ck_payment_method CHECK (method IN ('cash','credit_card','debit_card'))`);
  await c.query(`ALTER TABLE payment ADD CONSTRAINT ck_payment_amounts CHECK (amount_paid > 0 AND change_amount >= 0)`);
  await c.query(`ALTER TABLE product ADD CONSTRAINT ck_product_prices CHECK (purchase_price >= 0 AND sale_price >= 0)`);
  await c.query(`ALTER TABLE product ADD CONSTRAINT ck_product_margin CHECK (sale_price >= purchase_price) NOT VALID`);
  await c.query(`ALTER TABLE product_branch ADD CONSTRAINT ck_pb_quantity CHECK (quantity >= 0)`);
  await c.query(`ALTER TABLE order_detail ADD CONSTRAINT ck_od_quantity CHECK (quantity > 0)`);
}

// English schema: columns added by the intermediate versions (no-op when they already exist)
async function addNewColumns(c) {
  // Table status: 'free' renamed to 'available' ("free" means "no charge" in English; RF-25)
  // and new 'inactive' value (RF-03: a table is deactivated instead of deleted)
  const ck = await c.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ck_table_status'`);
  if (!ck.rowCount || !/'inactive'/.test(ck.rows[0].def)) {
    await c.query('ALTER TABLE bar_table DROP CONSTRAINT IF EXISTS ck_table_status');
    await c.query(`UPDATE bar_table SET status = 'available' WHERE status = 'free'`);
    await c.query(`ALTER TABLE bar_table ADD CONSTRAINT ck_table_status CHECK (status IN ('available','occupied','inactive'))`);
    await c.query(`ALTER TABLE bar_table ALTER COLUMN status SET DEFAULT 'available'`);
  }
  // RF-02: a branch is deactivated instead of deleted
  await c.query('ALTER TABLE branch ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE');

  // Deferred payment: new 'deferred' method and payment status ('paid' / 'pending')
  await c.query(`ALTER TABLE payment ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'paid'`);
  const pm = await c.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ck_payment_method'`);
  if (!pm.rowCount || !/'deferred'/.test(pm.rows[0].def)) {
    await c.query('ALTER TABLE payment DROP CONSTRAINT IF EXISTS ck_payment_method');
    await c.query(`ALTER TABLE payment ADD CONSTRAINT ck_payment_method CHECK (method IN ('cash','credit_card','debit_card','deferred'))`);
  }
  if (!(await constraintExists(c, 'ck_payment_status'))) {
    await c.query(`ALTER TABLE payment ADD CONSTRAINT ck_payment_status CHECK (status IN ('paid','pending'))`);
  }

  // RNF-22: the audit trail is INSERT-only, enforced by the database
  await c.query(`CREATE OR REPLACE FUNCTION audit_log_readonly() RETURNS trigger AS $$
                 BEGIN RAISE EXCEPTION 'audit_log is append-only: records cannot be modified or deleted'; END;
                 $$ LANGUAGE plpgsql`);
  await c.query('DROP TRIGGER IF EXISTS trg_audit_log_readonly ON audit_log');
  await c.query(`CREATE TRIGGER trg_audit_log_readonly BEFORE UPDATE OR DELETE ON audit_log
                 FOR EACH ROW EXECUTE FUNCTION audit_log_readonly()`);
  await c.query('DROP TRIGGER IF EXISTS trg_audit_log_no_truncate ON audit_log');
  await c.query(`CREATE TRIGGER trg_audit_log_no_truncate BEFORE TRUNCATE ON audit_log
                 FOR EACH STATEMENT EXECUTE FUNCTION audit_log_readonly()`);

  await c.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS category VARCHAR(20) NOT NULL DEFAULT 'general'`);
  await c.query('CREATE INDEX IF NOT EXISTS idx_log_date ON audit_log (created_at)');

  await c.query('ALTER TABLE customer_order ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP NULL');
  await c.query(`UPDATE customer_order o SET closed_at = p.paid_at FROM payment p
                  WHERE p.order_id = o.order_id AND o.status = 'closed' AND o.closed_at IS NULL`);

  // Cost frozen in each order line (to compute profit); old lines take the current purchase price
  if (!(await columnExists(c, 'order_detail', 'unit_cost'))) {
    await c.query('ALTER TABLE order_detail ADD COLUMN unit_cost DECIMAL(10,2) NULL');
    await c.query(`UPDATE order_detail d SET unit_cost = p.purchase_price FROM product p WHERE p.product_id = d.product_id`);
    await c.query('ALTER TABLE order_detail ALTER COLUMN unit_cost SET NOT NULL');
  }

  await c.query('ALTER TABLE payment ADD COLUMN IF NOT EXISTS amount_received DECIMAL(10,2) NULL');
  if (!(await columnExists(c, 'payment', 'cashier_id'))) {
    await c.query(`ALTER TABLE payment ADD COLUMN cashier_id INT NULL
                   CONSTRAINT fk_payment_cashier REFERENCES app_user(user_id) ON UPDATE CASCADE ON DELETE SET NULL`);
  }
  await c.query('ALTER TABLE app_user ADD COLUMN IF NOT EXISTS reset_authorized_until TIMESTAMP NULL');

  // Invoice lines (detalle_factura). Invoices issued before this table existed get their lines
  // from the order they belong to.
  await c.query(`CREATE TABLE IF NOT EXISTS invoice_detail (
      invoice_id  INT NOT NULL,
      product_id  INT NOT NULL,
      quantity    INT NOT NULL,
      unit_price  DECIMAL(10,2) NOT NULL,
      PRIMARY KEY (invoice_id, product_id),
      CONSTRAINT fk_id_invoice FOREIGN KEY (invoice_id) REFERENCES invoice(invoice_id) ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT fk_id_product FOREIGN KEY (product_id) REFERENCES product(product_id) ON UPDATE CASCADE ON DELETE RESTRICT,
      CONSTRAINT ck_id_quantity CHECK (quantity > 0))`);
  await c.query(`INSERT INTO invoice_detail (invoice_id, product_id, quantity, unit_price)
                 SELECT i.invoice_id, d.product_id, d.quantity, d.unit_price
                   FROM invoice i JOIN order_detail d ON d.order_id = i.order_id
                  WHERE NOT EXISTS (SELECT 1 FROM invoice_detail x WHERE x.invoice_id = i.invoice_id)`);
}

// ---------------------------------------------------------------------
//  English schema → Spanish names of the entity-relationship model
// ---------------------------------------------------------------------
const TO_SPANISH_TABLES = [
  ['branch', 'sede'], ['bar_table', 'mesa'], ['app_user', 'usuario'], ['audit_log', 'log_trazabilidad'],
  ['supplier', 'proveedor'], ['product_type', 'tipo_producto'], ['product', 'producto'],
  ['product_branch', 'producto_sede'], ['customer_order', 'pedido'], ['order_detail', 'detalle_pedido'],
  ['payment', 'pago'], ['invoice', 'factura'], ['invoice_detail', 'detalle_factura']
];

// By (already renamed) Spanish table: [english column, spanish column]
const TO_SPANISH_COLUMNS = {
  sede:             [['branch_id', 'id_sede'], ['name', 'nombre'], ['address', 'direccion'], ['active', 'activo']],
  mesa:             [['table_id', 'id_mesa'], ['branch_id', 'id_sede'], ['number', 'numero'], ['status', 'estado']],
  usuario:          [['user_id', 'id_usuario'], ['branch_id', 'id_sede'], ['full_name', 'nombre_completo'], ['role', 'rol'],
                     ['active', 'activo'], ['failed_attempts', 'intentos_fallidos'], ['session_token', 'token_sesion'],
                     ['reset_authorized_until', 'reset_autorizado_hasta']],
  log_trazabilidad: [['log_id', 'id_log'], ['user_id', 'id_usuario'], ['category', 'categoria'], ['operation', 'operacion'],
                     ['created_at', 'fecha_hora']],
  proveedor:        [['supplier_id', 'id_proveedor'], ['name', 'nombre']],
  tipo_producto:    [['type_id', 'id_tipo'], ['name', 'nombre']],
  producto:         [['product_id', 'id_producto'], ['type_id', 'id_tipo'], ['supplier_id', 'id_proveedor'], ['code', 'codigo'],
                     ['name', 'nombre'], ['purchase_price', 'valor_compra'], ['sale_price', 'valor_venta']],
  producto_sede:    [['branch_id', 'id_sede'], ['product_id', 'id_producto'], ['quantity', 'cantidad_disponible'],
                     ['is_active', 'estado_disponibilidad']],
  pedido:           [['order_id', 'id_pedido'], ['table_id', 'id_mesa'], ['unique_code', 'codigo_unico'],
                     ['created_at', 'fecha_hora'], ['closed_at', 'fecha_cierre'], ['status', 'estado']],
  detalle_pedido:   [['order_id', 'id_pedido'], ['product_id', 'id_producto'], ['quantity', 'cantidad'],
                     ['unit_price', 'valor_unitario'], ['unit_cost', 'costo_unitario']],
  pago:             [['payment_id', 'id_pago'], ['order_id', 'id_pedido'], ['cashier_id', 'id_cajero'], ['amount_paid', 'valor_pagado'],
                     ['amount_received', 'valor_recibido'], ['method', 'metodo_pago'], ['paid_at', 'fecha_hora'],
                     ['change_amount', 'cambio'], ['status', 'estado']],
  factura:          [['invoice_id', 'id_factura'], ['order_id', 'id_pedido'], ['payment_id', 'id_pago'], ['issued_at', 'fecha_emision']],
  detalle_factura:  [['invoice_id', 'id_factura'], ['product_id', 'id_producto'], ['quantity', 'cantidad'], ['unit_price', 'valor_unitario']]
};

// [spanish table, english constraint, spanish constraint]
const TO_SPANISH_CONSTRAINTS = [
  ['sede', 'branch_pkey', 'sede_pkey'], ['sede', 'branch_name_key', 'sede_nombre_key'],
  ['mesa', 'bar_table_pkey', 'mesa_pkey'], ['mesa', 'fk_table_branch', 'fk_mesa_sede'],
  ['mesa', 'uq_table_branch_number', 'uq_mesa_sede_numero'], ['mesa', 'ck_table_status', 'ck_mesa_estado'],
  ['usuario', 'app_user_pkey', 'usuario_pkey'], ['usuario', 'app_user_username_key', 'usuario_username_key'],
  ['usuario', 'fk_user_branch', 'fk_usuario_sede'], ['usuario', 'ck_user_role', 'ck_usuario_rol'],
  ['log_trazabilidad', 'audit_log_pkey', 'log_trazabilidad_pkey'], ['log_trazabilidad', 'fk_log_user', 'fk_log_usuario'],
  ['proveedor', 'supplier_pkey', 'proveedor_pkey'],
  ['tipo_producto', 'product_type_pkey', 'tipo_producto_pkey'], ['tipo_producto', 'product_type_name_key', 'tipo_producto_nombre_key'],
  ['producto', 'product_pkey', 'producto_pkey'], ['producto', 'product_code_key', 'producto_codigo_key'],
  ['producto', 'fk_product_type', 'fk_producto_tipo'], ['producto', 'fk_product_supplier', 'fk_producto_proveedor'],
  ['producto', 'ck_product_prices', 'ck_producto_valores'], ['producto', 'ck_product_margin', 'ck_producto_margen'],
  ['producto_sede', 'product_branch_pkey', 'producto_sede_pkey'], ['producto_sede', 'fk_pb_branch', 'fk_ps_sede'],
  ['producto_sede', 'fk_pb_product', 'fk_ps_producto'], ['producto_sede', 'ck_pb_quantity', 'ck_ps_cantidad'],
  ['pedido', 'customer_order_pkey', 'pedido_pkey'], ['pedido', 'customer_order_unique_code_key', 'pedido_codigo_unico_key'],
  ['pedido', 'fk_order_table', 'fk_pedido_mesa'], ['pedido', 'ck_order_status', 'ck_pedido_estado'],
  ['detalle_pedido', 'order_detail_pkey', 'detalle_pedido_pkey'], ['detalle_pedido', 'fk_od_order', 'fk_dp_pedido'],
  ['detalle_pedido', 'fk_od_product', 'fk_dp_producto'], ['detalle_pedido', 'ck_od_quantity', 'ck_dp_cantidad'],
  ['pago', 'payment_pkey', 'pago_pkey'], ['pago', 'payment_order_id_key', 'pago_id_pedido_key'],
  ['pago', 'fk_payment_order', 'fk_pago_pedido'], ['pago', 'fk_payment_cashier', 'fk_pago_cajero'],
  ['pago', 'ck_payment_method', 'ck_pago_metodo'], ['pago', 'ck_payment_status', 'ck_pago_estado'],
  ['pago', 'ck_payment_amounts', 'ck_pago_valores'],
  ['factura', 'invoice_pkey', 'factura_pkey'], ['factura', 'invoice_order_id_key', 'factura_id_pedido_key'],
  ['factura', 'invoice_payment_id_key', 'factura_id_pago_key'], ['factura', 'fk_invoice_order', 'fk_factura_pedido'],
  ['factura', 'fk_invoice_payment', 'fk_factura_pago'],
  ['detalle_factura', 'invoice_detail_pkey', 'detalle_factura_pkey'], ['detalle_factura', 'fk_id_invoice', 'fk_df_factura'],
  ['detalle_factura', 'fk_id_product', 'fk_df_producto'], ['detalle_factura', 'ck_id_quantity', 'ck_df_cantidad']
];

// Identity columns: their sequences get the Spanish name too
const IDENTITY_COLUMNS = [
  ['sede', 'id_sede'], ['mesa', 'id_mesa'], ['usuario', 'id_usuario'], ['log_trazabilidad', 'id_log'],
  ['proveedor', 'id_proveedor'], ['tipo_producto', 'id_tipo'], ['producto', 'id_producto'],
  ['pedido', 'id_pedido'], ['pago', 'id_pago'], ['factura', 'id_factura']
];

async function toSpanish(c) {
  // The English trigger goes away first; the Spanish one is created by auditTrailReadOnly()
  await c.query('DROP TRIGGER IF EXISTS trg_audit_log_readonly ON audit_log');
  await c.query('DROP TRIGGER IF EXISTS trg_audit_log_no_truncate ON audit_log');
  await c.query('DROP FUNCTION IF EXISTS audit_log_readonly()');

  for (const [en, es] of TO_SPANISH_TABLES) await c.query(`ALTER TABLE ${en} RENAME TO ${es}`);
  for (const [table, cols] of Object.entries(TO_SPANISH_COLUMNS)) {
    for (const [en, es] of cols) {
      if (await columnExists(c, table, en)) await c.query(`ALTER TABLE ${table} RENAME COLUMN ${en} TO ${es}`);
    }
  }
  for (const [table, en, es] of TO_SPANISH_CONSTRAINTS) {
    if (await constraintExists(c, en)) await c.query(`ALTER TABLE ${table} RENAME CONSTRAINT ${en} TO ${es}`);
  }
  // PostgreSQL 18+ names the NOT NULL constraints too (table_column_not_null)
  const notNull = await c.query(`
    SELECT k.conname, r.relname AS tbl, a.attname AS col
      FROM pg_constraint k
      JOIN pg_class r ON r.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = k.conkey[1]
     WHERE k.contype = 'n' AND n.nspname = current_schema()`);
  for (const { conname, tbl, col } of notNull.rows) {
    if (conname !== `${tbl}_${col}_not_null`) await c.query(`ALTER TABLE ${tbl} RENAME CONSTRAINT ${conname} TO ${tbl}_${col}_not_null`);
  }
  await c.query('ALTER INDEX IF EXISTS idx_log_user_date RENAME TO idx_log_usuario_fecha');
  await c.query('ALTER INDEX IF EXISTS idx_log_date RENAME TO idx_log_fecha');
  for (const [table, col] of IDENTITY_COLUMNS) {
    const seq = (await c.query('SELECT pg_get_serial_sequence($1, $2) AS s', [table, col])).rows[0].s;
    const wanted = `${table}_${col}_seq`;
    if (seq && seq.split('.').pop().replace(/"/g, '') !== wanted) await c.query(`ALTER SEQUENCE ${seq} RENAME TO ${wanted}`);
  }
}

// RNF-22: the audit trail is INSERT-only, enforced by the database
async function auditTrailReadOnly(c) {
  await c.query(`CREATE OR REPLACE FUNCTION log_trazabilidad_solo_insercion() RETURNS trigger AS $$
                 BEGIN RAISE EXCEPTION 'log_trazabilidad is append-only: records cannot be modified or deleted'; END;
                 $$ LANGUAGE plpgsql`);
  await c.query('DROP TRIGGER IF EXISTS trg_log_trazabilidad_solo_insercion ON log_trazabilidad');
  await c.query(`CREATE TRIGGER trg_log_trazabilidad_solo_insercion BEFORE UPDATE OR DELETE ON log_trazabilidad
                 FOR EACH ROW EXECUTE FUNCTION log_trazabilidad_solo_insercion()`);
  await c.query('DROP TRIGGER IF EXISTS trg_log_trazabilidad_sin_truncate ON log_trazabilidad');
  await c.query(`CREATE TRIGGER trg_log_trazabilidad_sin_truncate BEFORE TRUNCATE ON log_trazabilidad
                 FOR EACH STATEMENT EXECUTE FUNCTION log_trazabilidad_solo_insercion()`);
}

// Returns a short description of what was done
async function migrate(pool) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const steps = [];
    // First Spanish version: it has "sede" but not "sede.activo" (added later)
    if (await tableExists(c, 'sede') && !(await columnExists(c, 'sede', 'activo')) && !(await tableExists(c, 'branch'))) {
      await fromSpanish(c);
      steps.push('first version upgraded');
    }
    if (await tableExists(c, 'branch')) {
      await addNewColumns(c);
      await toSpanish(c);
      steps.push('tables and columns renamed to Spanish');
    }
    if (!(await tableExists(c, 'sede'))) {
      throw new Error('The database has no tables. Run: npm run init-db');
    }
    await auditTrailReadOnly(c);
    await c.query('COMMIT');
    return steps.length ? `Schema migrated: ${steps.join(', ')} (data preserved)` : 'Schema up to date';
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

module.exports = { migrate };

// Standalone: npm run migrate
if (require.main === module) {
  const { pool } = require('./db');
  migrate(pool)
    .then((msg) => { console.log('✔ ' + msg); return pool.end(); })
    .catch((e) => { console.error('✖ Migration failed (nothing was changed):', e.message); process.exit(1); });
}
