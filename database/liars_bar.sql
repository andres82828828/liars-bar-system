-- =====================================================================
--  LIAR'S BAR - Management System
--  PostgreSQL database (run with: npm run init-db)
--  WARNING: this script DROPS and recreates every table.
-- =====================================================================

-- Clean up so the script can be re-run from scratch
DROP TABLE IF EXISTS invoice_detail, invoice, payment, order_detail, customer_order, product_branch,
                     product, product_type, supplier, audit_log,
                     app_user, bar_table, branch CASCADE;

-- ---------------------------------------------------------------------
--  1. BRANCHES AND TABLES
-- ---------------------------------------------------------------------
CREATE TABLE branch (
    branch_id   INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(50)  NOT NULL UNIQUE,
    address     VARCHAR(100) NOT NULL
);

CREATE TABLE bar_table (
    table_id    INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    branch_id   INT NOT NULL,
    number      INT NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'free',
    CONSTRAINT fk_table_branch FOREIGN KEY (branch_id) REFERENCES branch(branch_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT uq_table_branch_number UNIQUE (branch_id, number),
    CONSTRAINT ck_table_status CHECK (status IN ('free','occupied'))
);

-- ---------------------------------------------------------------------
--  2. USERS AND AUDIT TRAIL
--     branch_id is NULL for the Administrator (access to every branch)
-- ---------------------------------------------------------------------
CREATE TABLE app_user (
    user_id                INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    branch_id              INT NULL,
    username               VARCHAR(50)  NOT NULL UNIQUE,
    password_hash          VARCHAR(255) NOT NULL,            -- bcrypt, never plain text
    full_name              VARCHAR(100) NOT NULL,
    role                   VARCHAR(20)  NOT NULL,
    active                 BOOLEAN      NOT NULL DEFAULT TRUE,
    failed_attempts        INT          NOT NULL DEFAULT 0,  -- locked when >= 3
    session_token          VARCHAR(255) NULL,                -- NULL = no active session
    reset_authorized_until TIMESTAMP    NULL,                -- admin allowed a password change until this time
    CONSTRAINT fk_user_branch FOREIGN KEY (branch_id) REFERENCES branch(branch_id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT ck_user_role CHECK (role IN ('Administrator','Cashier','Waiter'))
);

-- Every traceable operation: who (user), when (created_at), what (category + operation)
CREATE TABLE audit_log (
    log_id      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     INT NOT NULL,
    category    VARCHAR(20) NOT NULL DEFAULT 'general',
    operation   TEXT NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_log_user FOREIGN KEY (user_id) REFERENCES app_user(user_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX idx_log_user_date ON audit_log (user_id, created_at);
CREATE INDEX idx_log_date ON audit_log (created_at);

-- ---------------------------------------------------------------------
--  3. PRODUCTS AND INVENTORY
-- ---------------------------------------------------------------------
CREATE TABLE supplier (
    supplier_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(100) NOT NULL
);

CREATE TABLE product_type (
    type_id  INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name     VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE product (
    product_id     INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type_id        INT NOT NULL,
    supplier_id    INT NOT NULL,
    code           VARCHAR(50)  NOT NULL UNIQUE,
    name           VARCHAR(100) NOT NULL,
    purchase_price DECIMAL(10,2) NOT NULL,
    sale_price     DECIMAL(10,2) NOT NULL,
    CONSTRAINT fk_product_type     FOREIGN KEY (type_id)     REFERENCES product_type(type_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_product_supplier FOREIGN KEY (supplier_id) REFERENCES supplier(supplier_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT ck_product_prices CHECK (purchase_price >= 0 AND sale_price >= 0),
    CONSTRAINT ck_product_margin CHECK (sale_price >= purchase_price)   -- never sell below cost
);

-- Inventory per branch (N:M between product and branch)
-- is_active = the administrator offers the product in that branch (independent of stock)
CREATE TABLE product_branch (
    branch_id   INT NOT NULL,
    product_id  INT NOT NULL,
    quantity    INT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (branch_id, product_id),
    CONSTRAINT fk_pb_branch  FOREIGN KEY (branch_id)  REFERENCES branch(branch_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_pb_product FOREIGN KEY (product_id) REFERENCES product(product_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT ck_pb_quantity CHECK (quantity >= 0)
);

-- ---------------------------------------------------------------------
--  4. ORDERS, PAYMENTS AND INVOICES
-- ---------------------------------------------------------------------
-- open → closed (paid, table released, no more changes) · open → cancelled (empty order only)
CREATE TABLE customer_order (
    order_id     INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    table_id     INT NOT NULL,
    unique_code  VARCHAR(50) NOT NULL UNIQUE,
    created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at    TIMESTAMP   NULL,
    status       VARCHAR(20) NOT NULL DEFAULT 'open',
    CONSTRAINT fk_order_table FOREIGN KEY (table_id) REFERENCES bar_table(table_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT ck_order_status CHECK (status IN ('open','closed','cancelled'))
);

CREATE TABLE order_detail (
    order_id    INT NOT NULL,
    product_id  INT NOT NULL,
    quantity    INT NOT NULL,
    unit_price  DECIMAL(10,2) NOT NULL,   -- sale price frozen when the product was added
    unit_cost   DECIMAL(10,2) NOT NULL,   -- purchase price frozen at that moment (to compute profit)
    PRIMARY KEY (order_id, product_id),
    CONSTRAINT fk_od_order   FOREIGN KEY (order_id)   REFERENCES customer_order(order_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_od_product FOREIGN KEY (product_id) REFERENCES product(product_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT ck_od_quantity CHECK (quantity > 0)
);

-- Order 1:1 Payment (UNIQUE order_id)
CREATE TABLE payment (
    payment_id      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id        INT NOT NULL UNIQUE,
    cashier_id      INT NULL,                      -- user who registered the payment
    amount_paid     DECIMAL(10,2) NOT NULL,        -- order total
    amount_received DECIMAL(10,2) NULL,            -- money handed over by the customer
    method          VARCHAR(30)   NOT NULL,
    paid_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    change_amount   DECIMAL(10,2) NOT NULL DEFAULT 0,
    CONSTRAINT fk_payment_order FOREIGN KEY (order_id) REFERENCES customer_order(order_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_payment_cashier FOREIGN KEY (cashier_id) REFERENCES app_user(user_id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT ck_payment_method CHECK (method IN ('cash','credit_card','debit_card')),
    CONSTRAINT ck_payment_amounts CHECK (amount_paid > 0 AND change_amount >= 0)
);

-- Order 1:1 Invoice (UNIQUE order_id) linked to its payment
CREATE TABLE invoice (
    invoice_id  INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id    INT NOT NULL UNIQUE,
    payment_id  INT NOT NULL UNIQUE,
    issued_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_invoice_order   FOREIGN KEY (order_id)   REFERENCES customer_order(order_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_invoice_payment FOREIGN KEY (payment_id) REFERENCES payment(payment_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Invoice lines: products, quantities and unit price copied from the order when the invoice is issued
CREATE TABLE invoice_detail (
    invoice_id  INT NOT NULL,
    product_id  INT NOT NULL,
    quantity    INT NOT NULL,
    unit_price  DECIMAL(10,2) NOT NULL,   -- price in Colombian pesos (COP)
    PRIMARY KEY (invoice_id, product_id),
    CONSTRAINT fk_id_invoice FOREIGN KEY (invoice_id) REFERENCES invoice(invoice_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_id_product FOREIGN KEY (product_id) REFERENCES product(product_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT ck_id_quantity CHECK (quantity > 0)
);

-- =====================================================================
--  SEED DATA
-- =====================================================================

INSERT INTO branch (name, address) VALUES
  ('Zona T',   'Cra. 13 # 82-34'),
  ('Modelia',  'Cl. 23g # 74-98'),
  ('Galerías', 'Cl. 53 # 27-24');

INSERT INTO bar_table (branch_id, number, status) VALUES
  (1, 1, 'free'),
  (1, 2, 'occupied'),
  (2, 1, 'free'),
  (2, 2, 'free'),
  (3, 1, 'free');

-- Passwords (bcrypt hash):  Admin123* / Cajero123* / Mesero123*
INSERT INTO app_user (branch_id, username, password_hash, full_name, role) VALUES
  (NULL, 'cmendoza', '$2b$10$VMLOEiRtppuzcJ7J1nZc3euPuTlxKYuKwisxE9SQ.f15RDAGCoSlW', 'Carlos Mendoza', 'Administrator'),
  (1,    'aperez',   '$2b$10$BmrYPxtz7EIPOh4vAurR7eqHD.XhU64kcz1v.///LzZCnJSQKuOwe', 'Andrés Pérez',   'Cashier'),
  (2,    'lgarcia',  '$2b$10$aGHzaoN/oqi1yTH62oZip.16dHhqk180gu5DmKghGuRn.AbOileCa', 'Laura García',   'Waiter');

-- Sample catalog
INSERT INTO supplier (name) VALUES
  ('Distribuidora Andina'),
  ('Licores del Valle');

INSERT INTO product_type (name) VALUES
  ('Liquor'), ('Beer'), ('Cocktails'), ('Food');

INSERT INTO product (type_id, supplier_id, code, name, purchase_price, sale_price) VALUES
  (1, 2, 'LIC-001', 'Aguardiente (half bottle)', 28000.00, 55000.00),
  (2, 1, 'BEE-001', 'Club Colombia Beer',         3500.00, 12000.00),
  (3, 2, 'COC-001', 'Mojito',                     6000.00, 24000.00),
  (4, 1, 'FOO-001', 'Cheese Nachos',              7000.00, 22000.00);

INSERT INTO product_branch (branch_id, product_id, quantity, is_active)
SELECT b.branch_id, p.product_id, 50, TRUE
FROM branch b CROSS JOIN product p;

-- Sample OPEN order on table 2 of Zona T (the table is 'occupied').
-- Its products were already taken out of Zona T's inventory.
INSERT INTO customer_order (table_id, unique_code, status) VALUES (2, 'ORD-SAMPLE-0001', 'open');
INSERT INTO order_detail (order_id, product_id, quantity, unit_price, unit_cost) VALUES
  (1, 2, 4, 12000.00, 3500.00),
  (1, 4, 1, 22000.00, 7000.00);
UPDATE product_branch SET quantity = 46 WHERE branch_id = 1 AND product_id = 2;
UPDATE product_branch SET quantity = 49 WHERE branch_id = 1 AND product_id = 4;

INSERT INTO audit_log (user_id, category, operation) VALUES
  (1, 'system', 'Database initialized'),
  (2, 'orders', 'Created order ORD-SAMPLE-0001 on table #2');
