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
| Cash desk: charge orders, invoices | | ✔ (own branch) | ✔ (one or all branches) |
| Add stock to the inventory | | ✔ (own branch) | ✔ |
| Catalog, activate products per branch, users, branches | | | ✔ |
| Sales report, Excel export, audit trail | | | ✔ |

The Administrator keeps all management permissions and can also do the Waiter and Cashier work.
Every permission is enforced by the server, not only by the menu.

## How it works

1. **Tables & orders**: tap a free table → **Create order** (unique code `ORD-YYYYMMDD-XXXXXX`, the table becomes *occupied*).
   Add products from the catalog (only active products with stock in that branch). Added products cannot be removed.
2. **Cash desk**: open orders of the branch with table and total → **Charge**.
   - Payment methods: cash, credit card, debit card.
   - Cash: the amount received must cover the total; the change is computed and broken down into bills and coins
     with a **greedy algorithm** (`changeBreakdown` in `frontend/js/pages-cashier.js`).
   - Card: the exact total is charged.
3. When the payment is valid, in one transaction: the payment is saved, the order is **closed** (no more changes),
   the table is **released** and the **invoice** is generated (`INV-000001`…).
4. **Invoices**: list by date; each invoice shows business and branch data, order, table, cashier,
   products and quantities, total, payment method, amount received and change. It can be printed.
5. **Sales report** (Administrator): closed orders filtered by date range and branch, with revenue, cost,
   **profit** and margin by branch and by product. Cost and price are frozen in each order line, so later
   price changes do not alter past reports. **Export to Excel** creates an `.xlsx` with 4 sheets
   (Summary, By branch, By product, Sales); before sending it the server checks that every sheet adds up to the summary.
6. **Audit trail** (Administrator): every traceable operation is stored with user, date/time, category and description
   (authentication, users, branches, catalog, inventory, orders, payments, invoices, reports, security).
   Filters by date, user, category and text. Denied access attempts are recorded too.

## Business rules
- The sale price cannot be lower than the purchase price.
- User registration validates name, username (no spaces/accents, unique ignoring case) and password
  (8–64 characters, one uppercase letter, one number, no spaces, not containing the username).
- A product can be active or inactive per branch; inactive products cannot be ordered even with stock.
  Products at 0 units are *out of stock* but stay active.
- Only empty orders can be cancelled. Closed orders cannot be modified, cancelled or paid again.
- If two people pick the same table (or the same stock) at the same time, only one wins (transactions + row locks).
- Login with bcrypt, lock after 3 failed attempts, single session per account, sign-out after 3 minutes of inactivity.
- Password change from the login screen only after an administrator authorizes it (30 minutes, single use).

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
| "The account already has an active session" after closing the browser | Wait 4 minutes or restart the server. |
| The page looks unstyled / old | Reload with `Ctrl + F5`. |
