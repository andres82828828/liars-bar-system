-- =====================================================================
--  LIAR'S BAR - Management System
--  PostgreSQL database (run with: npm run init-db)
--  Table and column names follow the entity-relationship model (Spanish).
--  WARNING: this script DROPS and recreates every table.
-- =====================================================================

-- Clean up so the script can be re-run from scratch (also drops the old English tables)
DROP TABLE IF EXISTS invoice_detail, invoice, payment, order_detail, customer_order, product_branch,
                     product, product_type, supplier, audit_log, app_user, bar_table, branch CASCADE;
DROP TABLE IF EXISTS detalle_factura, factura, pago, detalle_pedido, pedido, producto_sede,
                     producto, tipo_producto, proveedor, log_trazabilidad,
                     usuario, mesa, sede CASCADE;

-- ---------------------------------------------------------------------
--  1. SEDES Y MESAS (branches and tables)
-- ---------------------------------------------------------------------
CREATE TABLE sede (
    id_sede     INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre      VARCHAR(50)  NOT NULL UNIQUE,
    direccion   VARCHAR(100) NOT NULL,
    activo      BOOLEAN      NOT NULL DEFAULT TRUE   -- deactivated instead of deleted (RF-02)
);

CREATE TABLE mesa (
    id_mesa     INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_sede     INT NOT NULL,
    numero      INT NOT NULL,
    estado      VARCHAR(20) NOT NULL DEFAULT 'available',
    CONSTRAINT fk_mesa_sede FOREIGN KEY (id_sede) REFERENCES sede(id_sede)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT uq_mesa_sede_numero UNIQUE (id_sede, numero),
    CONSTRAINT ck_mesa_estado CHECK (estado IN ('available','occupied','inactive'))
);

-- ---------------------------------------------------------------------
--  2. USUARIOS Y BITÁCORA (users and audit trail)
--     id_sede is NULL for the Administrator (access to every branch)
-- ---------------------------------------------------------------------
CREATE TABLE usuario (
    id_usuario             INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_sede                INT NULL,
    username               VARCHAR(50)  NOT NULL UNIQUE,
    password_hash          VARCHAR(255) NOT NULL,            -- bcrypt, never plain text
    nombre_completo        VARCHAR(100) NOT NULL,
    rol                    VARCHAR(20)  NOT NULL,
    activo                 BOOLEAN      NOT NULL DEFAULT TRUE,
    intentos_fallidos      INT          NOT NULL DEFAULT 0,  -- locked when >= 3
    token_sesion           VARCHAR(255) NULL,                -- NULL = no active session
    reset_autorizado_hasta TIMESTAMP    NULL,                -- admin allowed a password change until this time
    CONSTRAINT fk_usuario_sede FOREIGN KEY (id_sede) REFERENCES sede(id_sede)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT ck_usuario_rol CHECK (rol IN ('Administrator','Cashier','Waiter'))
);

-- Every traceable operation: who (id_usuario), when (fecha_hora), what (categoria + operacion)
CREATE TABLE log_trazabilidad (
    id_log      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_usuario  INT NOT NULL,
    categoria   VARCHAR(20) NOT NULL DEFAULT 'general',
    operacion   TEXT NOT NULL,
    fecha_hora  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_log_usuario FOREIGN KEY (id_usuario) REFERENCES usuario(id_usuario)
        ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX idx_log_usuario_fecha ON log_trazabilidad (id_usuario, fecha_hora);
CREATE INDEX idx_log_fecha ON log_trazabilidad (fecha_hora);

-- The audit trail is INSERT-only (RNF-22): the database itself rejects any change or deletion
CREATE OR REPLACE FUNCTION log_trazabilidad_solo_insercion() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'log_trazabilidad is append-only: records cannot be modified or deleted';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_log_trazabilidad_solo_insercion BEFORE UPDATE OR DELETE ON log_trazabilidad
    FOR EACH ROW EXECUTE FUNCTION log_trazabilidad_solo_insercion();
CREATE TRIGGER trg_log_trazabilidad_sin_truncate BEFORE TRUNCATE ON log_trazabilidad
    FOR EACH STATEMENT EXECUTE FUNCTION log_trazabilidad_solo_insercion();

-- ---------------------------------------------------------------------
--  3. PRODUCTOS E INVENTARIO (products and inventory)
-- ---------------------------------------------------------------------
CREATE TABLE proveedor (
    id_proveedor INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre       VARCHAR(100) NOT NULL
);

CREATE TABLE tipo_producto (
    id_tipo  INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre   VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE producto (
    id_producto    INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_tipo        INT NOT NULL,
    id_proveedor   INT NOT NULL,
    codigo         VARCHAR(50)  NOT NULL UNIQUE,
    nombre         VARCHAR(100) NOT NULL,
    valor_compra   DECIMAL(10,2) NOT NULL,
    valor_venta    DECIMAL(10,2) NOT NULL,
    CONSTRAINT fk_producto_tipo      FOREIGN KEY (id_tipo)      REFERENCES tipo_producto(id_tipo)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_producto_proveedor FOREIGN KEY (id_proveedor) REFERENCES proveedor(id_proveedor)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT ck_producto_valores CHECK (valor_compra >= 0 AND valor_venta >= 0),
    CONSTRAINT ck_producto_margen  CHECK (valor_venta >= valor_compra)   -- never sell below cost
);

-- Inventory per branch (N:M between producto and sede)
-- estado_disponibilidad = the administrator offers the product in that branch (independent of stock)
CREATE TABLE producto_sede (
    id_sede               INT NOT NULL,
    id_producto           INT NOT NULL,
    cantidad_disponible   INT NOT NULL DEFAULT 0,
    estado_disponibilidad BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (id_sede, id_producto),
    CONSTRAINT fk_ps_sede     FOREIGN KEY (id_sede)     REFERENCES sede(id_sede)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_ps_producto FOREIGN KEY (id_producto) REFERENCES producto(id_producto)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT ck_ps_cantidad CHECK (cantidad_disponible >= 0)
);

-- ---------------------------------------------------------------------
--  4. PEDIDOS, PAGOS Y FACTURAS (orders, payments and invoices)
-- ---------------------------------------------------------------------
-- open → closed (paid, table released, no more changes) · open → cancelled (empty order only)
CREATE TABLE pedido (
    id_pedido     INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_mesa       INT NOT NULL,
    codigo_unico  VARCHAR(50) NOT NULL UNIQUE,
    fecha_hora    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_cierre  TIMESTAMP   NULL,
    estado        VARCHAR(20) NOT NULL DEFAULT 'open',
    CONSTRAINT fk_pedido_mesa FOREIGN KEY (id_mesa) REFERENCES mesa(id_mesa)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT ck_pedido_estado CHECK (estado IN ('open','closed','cancelled'))
);

CREATE TABLE detalle_pedido (
    id_pedido       INT NOT NULL,
    id_producto     INT NOT NULL,
    cantidad        INT NOT NULL,
    valor_unitario  DECIMAL(10,2) NOT NULL,   -- sale price frozen when the product was added
    costo_unitario  DECIMAL(10,2) NOT NULL,   -- purchase price frozen at that moment (to compute profit)
    PRIMARY KEY (id_pedido, id_producto),
    CONSTRAINT fk_dp_pedido   FOREIGN KEY (id_pedido)   REFERENCES pedido(id_pedido)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_dp_producto FOREIGN KEY (id_producto) REFERENCES producto(id_producto)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT ck_dp_cantidad CHECK (cantidad > 0)
);

-- Pedido 1:1 Pago (UNIQUE id_pedido)
CREATE TABLE pago (
    id_pago         INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_pedido       INT NOT NULL UNIQUE,
    id_cajero       INT NULL,                      -- user who registered the payment
    valor_pagado    DECIMAL(10,2) NOT NULL,        -- order total
    valor_recibido  DECIMAL(10,2) NULL,            -- money handed over by the customer
    metodo_pago     VARCHAR(30)   NOT NULL,
    fecha_hora      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cambio          DECIMAL(10,2) NOT NULL DEFAULT 0,
    estado          VARCHAR(20)   NOT NULL DEFAULT 'paid',   -- 'pending' = deferred payment not collected yet
    CONSTRAINT fk_pago_pedido FOREIGN KEY (id_pedido) REFERENCES pedido(id_pedido)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_pago_cajero FOREIGN KEY (id_cajero) REFERENCES usuario(id_usuario)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT ck_pago_metodo CHECK (metodo_pago IN ('cash','credit_card','debit_card','deferred')),
    CONSTRAINT ck_pago_estado CHECK (estado IN ('paid','pending')),
    CONSTRAINT ck_pago_valores CHECK (valor_pagado > 0 AND cambio >= 0)
);

-- Pedido 1:1 Factura (UNIQUE id_pedido) linked to its payment
CREATE TABLE factura (
    id_factura     INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_pedido      INT NOT NULL UNIQUE,
    id_pago        INT NOT NULL UNIQUE,
    fecha_emision  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_factura_pedido FOREIGN KEY (id_pedido) REFERENCES pedido(id_pedido)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_factura_pago   FOREIGN KEY (id_pago)   REFERENCES pago(id_pago)
        ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Invoice lines: products, quantities and unit price copied from the order when the invoice is issued
CREATE TABLE detalle_factura (
    id_factura      INT NOT NULL,
    id_producto     INT NOT NULL,
    cantidad        INT NOT NULL,
    valor_unitario  DECIMAL(10,2) NOT NULL,   -- price in Colombian pesos (COP)
    PRIMARY KEY (id_factura, id_producto),
    CONSTRAINT fk_df_factura  FOREIGN KEY (id_factura)  REFERENCES factura(id_factura)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_df_producto FOREIGN KEY (id_producto) REFERENCES producto(id_producto)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT ck_df_cantidad CHECK (cantidad > 0)
);

-- =====================================================================
--  SEED DATA
-- =====================================================================

INSERT INTO sede (nombre, direccion) VALUES
  ('Zona T',   'Cra. 13 # 82-34'),
  ('Modelia',  'Cl. 23g # 74-98'),
  ('Galerías', 'Cl. 53 # 27-24');

INSERT INTO mesa (id_sede, numero, estado) VALUES
  (1, 1, 'available'),
  (1, 2, 'occupied'),
  (2, 1, 'available'),
  (2, 2, 'available'),
  (3, 1, 'available');

-- Passwords (bcrypt hash):  Admin123* / Cajero123* / Mesero123*
INSERT INTO usuario (id_sede, username, password_hash, nombre_completo, rol) VALUES
  (NULL, 'cmendoza', '$2b$10$VMLOEiRtppuzcJ7J1nZc3euPuTlxKYuKwisxE9SQ.f15RDAGCoSlW', 'Carlos Mendoza', 'Administrator'),
  (1,    'aperez',   '$2b$10$BmrYPxtz7EIPOh4vAurR7eqHD.XhU64kcz1v.///LzZCnJSQKuOwe', 'Andrés Pérez',   'Cashier'),
  (2,    'lgarcia',  '$2b$10$aGHzaoN/oqi1yTH62oZip.16dHhqk180gu5DmKghGuRn.AbOileCa', 'Laura García',   'Waiter');

-- Sample catalog
INSERT INTO proveedor (nombre) VALUES
  ('Distribuidora Andina'),
  ('Licores del Valle');

INSERT INTO tipo_producto (nombre) VALUES
  ('Liquor'), ('Beer'), ('Cocktails'), ('Food');

INSERT INTO producto (id_tipo, id_proveedor, codigo, nombre, valor_compra, valor_venta) VALUES
  (1, 2, 'LIC-001', 'Aguardiente (half bottle)', 28000.00, 55000.00),
  (2, 1, 'BEE-001', 'Club Colombia Beer',         3500.00, 12000.00),
  (3, 2, 'COC-001', 'Mojito',                     6000.00, 24000.00),
  (4, 1, 'FOO-001', 'Cheese Nachos',              7000.00, 22000.00);

INSERT INTO producto_sede (id_sede, id_producto, cantidad_disponible, estado_disponibilidad)
SELECT s.id_sede, p.id_producto, 50, TRUE
FROM sede s CROSS JOIN producto p;

-- Sample OPEN order on table 2 of Zona T (the table is 'occupied').
-- Its products were already taken out of Zona T's inventory.
INSERT INTO pedido (id_mesa, codigo_unico, estado) VALUES (2, 'ORD-SAMPLE-0001', 'open');
INSERT INTO detalle_pedido (id_pedido, id_producto, cantidad, valor_unitario, costo_unitario) VALUES
  (1, 2, 4, 12000.00, 3500.00),
  (1, 4, 1, 22000.00, 7000.00);
UPDATE producto_sede SET cantidad_disponible = 46 WHERE id_sede = 1 AND id_producto = 2;
UPDATE producto_sede SET cantidad_disponible = 49 WHERE id_sede = 1 AND id_producto = 4;

INSERT INTO log_trazabilidad (id_usuario, categoria, operacion) VALUES
  (1, 'system', 'Database initialized'),
  (2, 'orders', 'Created order ORD-SAMPLE-0001 on table #2');
