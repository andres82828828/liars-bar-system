# Liar's Bar — Management System

Frontend (HTML/CSS/JS) + Backend (Node.js + Express) + Database (PostgreSQL).

```
liars-bar-system/
├── database/liars_bar.sql     ← tables + seed data
├── backend/
│   ├── server.js              ← app setup, sessions, permissions, audit log
│   ├── migrate.js             ← schema migration (keeps your data)
│   ├── init-db.js             ← creates the database from scratch
│   ├── validators.js          ← shared input validation
│   ├── routes/                ← auth, users, branches, products, inventory,
│   │                            orders, invoices, reports, audit
│   └── tests/                 ← API tests (npm test)
└── frontend/
    ├── index.html / style.css / sorting.js
    └── js/                    ← app.js (core) + pages-*.js
```

## Installation (Windows)

1. **PostgreSQL**: https://www.postgresql.org/download/windows/ — write down the `postgres` user password.
2. **Node.js LTS**: https://nodejs.org (check with `node -v`).
3. In the `backend` folder: copy `.env.example` as `.env` and set `DB_PASSWORD` (and `DB_PORT` if it is not 5432).
4. In a terminal, inside `backend`:
   ```
   npm install
   npm run init-db      ← only the first time: creates the database and loads the seed data
   npm start
   ```
5. Open **http://localhost:3000**

Demo users: `cmendoza / Admin123*` (Administrator), `aperez / Cajero123*` (Cashier, Zona T), `lgarcia / Mesero123*` (Waiter, Modelia).

> `npm run init-db` drops and recreates every table. Use it to start from scratch, not when you
> have data you want to keep. For daily use just run `npm start`.

### Upgrading a database created with the Spanish version
`npm start` detects the old Spanish tables (`sede`, `mesa`, `pedido`…) and renames tables, columns and
status values to English **without losing data**, in a single transaction (all or nothing).
You can also run it by hand with `npm run migrate`. Running it again does nothing.

## Roles

| Feature | Waiter | Cashier | Administrator |
|---|:-:|:-:|:-:|
| Tables, create orders, add products | ✔ (own branch) | ✔ (own branch) | ✔ (any branch) |
| Remove products from an open order, cancel orders (RF-48) | | ✔ (own branch) | ✔ (any branch) |
| Cash desk: charge orders (also deferred payments), invoices | | ✔ (own branch) | ✔ (one or all branches) |
| Add stock to the inventory | | ✔ (own branch) | ✔ |
| Catalog, activate products per branch | | | ✔ |
| Users: create, edit (name, role, branch), activate / deactivate (RF-01) | | | ✔ |
| Branches and tables: create, edit, activate / deactivate (RF-02, RF-03) | | | ✔ |
| Sales report, Excel export | | ✔ (own branch) | ✔ (one or all branches) |
| Audit trail | | | ✔ |

The Administrator keeps all management permissions and can also do the Waiter and Cashier work.
Every permission is enforced by the server, not only by the menu.

## How it works

1. **Tables & orders**: tap an available table → **Create order** (unique code `ORD-YYYYMMDD-XXXXXX`, the table becomes *occupied*).
   Add products from the catalog (only active products with stock in that branch). While the order is open, the Cashier and the Administrator can remove products (all units or some); they go back
   to the branch inventory. The Waiter can only add products (RF-48).
2. **Cash desk**: open orders of the branch with table and total → **Charge**.
   - Payment methods: cash, credit card, debit card and **deferred payment**.
   - Cash: the amount received must cover the total; the change is computed and broken down into bills and coins
     with a **greedy algorithm** (`changeBreakdown` in `frontend/js/pages-cashier.js`).
   - Card: the exact total is charged.
   - Deferred: the order is closed, the table released and the invoice issued, but the payment stays **pending**.
     It appears under "Deferred payments to collect" in the Cash desk until it is collected with cash or card.
3. When the payment is valid, in one transaction: the payment is saved, the order is **closed** (no more changes),
   the table is **released** and the **invoice** is generated (`INV-000001`…) with its lines saved in `invoice_detail`.
4. **Invoices**: list by date; each invoice shows business and branch data, order, table, cashier,
   products and quantities, total, payment method, amount received and change. It can be printed.
5. **Sales report** (Administrator: any branch · Cashier: own branch): closed orders filtered by date range
   (by **order date** — when the order was taken — or by payment date) and branch, with revenue, cost,
   **profit** and margin by branch, by product (per day, with the unit purchase and sale value) and per sale. Cost and price are frozen in each order line, so later
   price changes do not alter past reports. **Export to Excel** creates an `.xlsx` with 4 sheets
   (Summary, By branch, By product, Sales); before sending it the server checks that every sheet adds up to the summary.
6. **Audit trail** (Administrator): every traceable operation is stored with user, date/time, category and description
   (authentication, users, branches, catalog, inventory, orders, payments, invoices, reports, security).
   Filters by date, user, category and text. Denied access attempts are recorded too.

## Business rules
- Amounts are in Colombian pesos (COP), shown as `$55.000`.
- The sale price cannot be lower than the purchase price.
- User registration validates name, username (no spaces/accents, unique ignoring case) and password
  (8–64 characters, one uppercase letter, one number, no spaces, not containing the username).
- A product can be active or inactive per branch; inactive products cannot be ordered even with stock.
  Products at 0 units are *out of stock* but stay active.
- Only empty orders can be cancelled, and only by the Cashier or the Administrator (RF-48). Closed orders cannot
  be modified, cancelled or paid again.
- Table status: `available`, `occupied` or `inactive`. Users, branches and tables are deactivated, never deleted,
  so the history stays intact. The staff of an inactive branch cannot sign in, and it cannot receive orders.
- Inventory is taken out when a product is added to the order (it is reserved for that table) and goes back if
  the product is removed from the open order (RF-30).
- If two people pick the same table (or the same stock) at the same time, only one wins (transactions + row locks).
- Login with bcrypt, lock after 3 failed attempts, single session per account, sign-out after exactly 3 minutes
  of inactivity (the browser and the server close the session at the same moment, RNF-07).
- Password change from the login screen with **full name and username** (RF-24), only after an administrator
  authorizes it (30 minutes, single use).

## Security
- Login messages are generic ("Wrong username or password."): they do not reveal whether a username exists.
- Failed logins / password changes are limited per IP address (10 every 15 minutes, `LOGIN_MAX_FAILS_PER_IP`).
- Security headers with `helmet` (Content-Security-Policy, X-Content-Type-Options, etc.).
- The audit trail is append-only: database triggers reject any `UPDATE`, `DELETE` or `TRUNCATE` on `audit_log` (RNF-22).
- Technical errors are written to `backend/logs/error.log` with `winston` (RNF-23); the user only sees a generic
  message. Passwords, hashes and session tokens are never logged.

## Sorting algorithms
`frontend/sorting.js` implements Bubble, Insertion, Selection, Merge and Quick Sort by hand (no `Array.sort`).
The product list and the order catalog can be sorted with any of them; the screen shows the number of
comparisons and the complexity.

## Tests
```
cd backend
npm test
```
Creates a temporary database (`liars_bar_test`), starts the server, runs the API tests
(`backend/tests/api.test.js`: order closing, invoices, sales report, Excel export, audit trail,
administrator permissions…) and drops the temporary database. Your `liars_bar` database is never touched.

## Common problems
| Message | Solution |
|---|---|
| `ECONNREFUSED ... 5432` | PostgreSQL is not running (or the port in `.env` is wrong). Open Windows "Services" and start `postgresql-x64-XX`. |
| `28P01` / wrong password | Check `DB_PASSWORD` in `backend/.env`. |
| `EADDRINUSE 3000` | Another program uses the port. Set `PORT=3001` in `.env`. |
| "The account already has an active session" after closing the browser | Wait 3 minutes or restart the server. |
| "Too many failed attempts from this device" | Wait 15 minutes or restart the server. |
| The page looks unstyled / old | Reload with `Ctrl + F5`. |
