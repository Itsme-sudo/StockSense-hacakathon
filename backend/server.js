require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const app = express();
const port = Number(process.env.PORT || 4000);
const jwtSecret = process.env.JWT_SECRET || 'development-only-change-me';
const databaseFile = path.resolve(__dirname, process.env.DATABASE_FILE || './data/stocksense.db');

fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
const db = new Database(databaseFile);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

app.use(cors());
app.use(express.json({ limit: '1mb' }));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS warehouses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    manager TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
    category TEXT NOT NULL,
    uom TEXT NOT NULL,
    reorder_point INTEGER NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS stock (
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    PRIMARY KEY (product_id, warehouse_id)
  );
  CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('receipt', 'delivery', 'transfer', 'adjustment')),
    status TEXT NOT NULL,
    party TEXT NOT NULL DEFAULT '',
    reference TEXT NOT NULL DEFAULT '',
    warehouse_id INTEGER REFERENCES warehouses(id),
    from_warehouse_id INTEGER REFERENCES warehouses(id),
    to_warehouse_id INTEGER REFERENCES warehouses(id),
    reason TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS operation_items (
    operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (operation_id, product_id)
  );
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL REFERENCES operations(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    quantity_delta INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS password_otps (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

const seed = db.transaction(() => {
  if (!db.prepare('SELECT id FROM warehouses LIMIT 1').get()) {
    const addWarehouse = db.prepare('INSERT INTO warehouses (name, location, manager) VALUES (?, ?, ?)');
    addWarehouse.run('Main Warehouse', 'Building A', 'John Doe');
    addWarehouse.run('Production Floor', 'Building B', 'Jane Smith');
    addWarehouse.run('Retail Store', 'Downtown', 'Mike Johnson');
  }
  if (!db.prepare('SELECT id FROM products LIMIT 1').get()) {
    const addProduct = db.prepare('INSERT INTO products (name, sku, category, uom, reorder_point, description) VALUES (?, ?, ?, ?, ?, ?)');
    const steel = addProduct.run('Steel Rods', 'SR-001', 'raw', 'kg', 50, 'High quality steel rods').lastInsertRowid;
    const chairs = addProduct.run('Office Chairs', 'OC-002', 'finished', 'pcs', 10, 'Ergonomic office chairs').lastInsertRowid;
    const boxes = addProduct.run('Cardboard Boxes', 'CB-003', 'packaging', 'pcs', 100, 'Shipping boxes').lastInsertRowid;
    const stock = db.prepare('INSERT INTO stock (product_id, warehouse_id, quantity) VALUES (?, ?, ?)');
    stock.run(steel, 1, 500);
    stock.run(steel, 2, 100);
    stock.run(chairs, 1, 45);
    stock.run(chairs, 3, 20);
    stock.run(boxes, 1, 250);
  }
});
seed();

function id(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

function auth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return fail(res, 401, 'Authentication required');
  try {
    req.user = jwt.verify(token, jwtSecret);
    return next();
  } catch {
    return fail(res, 401, 'Invalid or expired token');
  }
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function operationItems(body) {
  if (!Array.isArray(body.items) || body.items.length === 0) throw new Error('At least one item is required');
  const merged = new Map();
  body.items.forEach(item => {
    const productId = positiveInteger(item.productId, 'productId');
    const quantity = positiveInteger(item.quantity, 'quantity');
    merged.set(productId, (merged.get(productId) || 0) + quantity);
  });
  return [...merged].map(([productId, quantity]) => ({ productId, quantity }));
}

function requireEntity(table, idValue, label) {
  const entity = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(idValue);
  if (!entity) throw new Error(`${label} not found`);
  return entity;
}

function stockAt(productId, warehouseId) {
  return db.prepare('SELECT quantity FROM stock WHERE product_id = ? AND warehouse_id = ?').get(productId, warehouseId)?.quantity || 0;
}

function changeStock(productId, warehouseId, delta) {
  requireEntity('products', productId, 'Product');
  requireEntity('warehouses', warehouseId, 'Warehouse');
  const current = stockAt(productId, warehouseId);
  if (current + delta < 0) throw new Error('Insufficient stock');
  db.prepare(`
    INSERT INTO stock (product_id, warehouse_id, quantity) VALUES (?, ?, ?)
    ON CONFLICT(product_id, warehouse_id) DO UPDATE SET quantity = excluded.quantity
  `).run(productId, warehouseId, current + delta);
}

function readOperation(idValue) {
  const operation = db.prepare('SELECT * FROM operations WHERE id = ?').get(idValue);
  if (!operation) return null;
  return {
    ...operation,
    items: db.prepare('SELECT product_id AS productId, quantity FROM operation_items WHERE operation_id = ?').all(idValue)
  };
}

function createOperation({ type, status, party, reference, warehouseId, fromWarehouseId, toWarehouseId, reason, notes, items, userId, apply }) {
  const operationId = id(type.slice(0, 3).toUpperCase());
  const transaction = db.transaction(() => {
    if (apply) apply();
    db.prepare(`
      INSERT INTO operations (id, type, status, party, reference, warehouse_id, from_warehouse_id, to_warehouse_id, reason, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(operationId, type, status, party || '', reference || '', warehouseId || null, fromWarehouseId || null, toWarehouseId || null, reason || '', notes || '', userId);
    const addItem = db.prepare('INSERT INTO operation_items (operation_id, product_id, quantity) VALUES (?, ?, ?)');
    items.forEach(item => addItem.run(operationId, item.productId, item.quantity));
    return operationId;
  });
  return readOperation(transaction());
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'stocksense-api' }));

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 8) return fail(res, 400, 'Name, email, and an 8-character password are required');
    const passwordHash = await bcrypt.hash(password, 12);
    const result = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run(name.trim(), email.trim(), passwordHash);
    const user = { id: Number(result.lastInsertRowid), name: name.trim(), email: email.trim() };
    return res.status(201).json({ user, token: jwt.sign(user, jwtSecret, { expiresIn: '7d' }) });
  } catch (error) {
    return fail(res, error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 400, error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Email is already registered' : error.message);
  }
});

app.post('/api/auth/login', async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(req.body.email || '');
  if (!user || !(await bcrypt.compare(req.body.password || '', user.password_hash))) return fail(res, 401, 'Invalid email or password');
  const safeUser = { id: user.id, name: user.name, email: user.email };
  return res.json({ user: safeUser, token: jwt.sign(safeUser, jwtSecret, { expiresIn: '7d' }) });
});

app.post('/api/auth/request-reset', async (req, res) => {
  const email = String(req.body.email || '').trim();
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) return res.json({ message: 'If the account exists, an OTP has been generated' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare('INSERT OR REPLACE INTO password_otps (email, code_hash, expires_at) VALUES (?, ?, ?)').run(email, await bcrypt.hash(code, 10), Date.now() + 10 * 60 * 1000);
  const response = { message: 'OTP generated' };
  if (process.env.NODE_ENV !== 'production') response.demoOtp = code;
  return res.json(response);
});

app.post('/api/auth/reset-password', async (req, res) => {
  const email = String(req.body.email || '').trim();
  const otp = String(req.body.otp || '');
  const password = String(req.body.password || '');
  const stored = db.prepare('SELECT * FROM password_otps WHERE email = ?').get(email);
  if (!stored || stored.expires_at < Date.now() || !(await bcrypt.compare(otp, stored.code_hash))) return fail(res, 400, 'Invalid or expired OTP');
  if (password.length < 8) return fail(res, 400, 'Password must contain at least 8 characters');
  db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(await bcrypt.hash(password, 12), email);
  db.prepare('DELETE FROM password_otps WHERE email = ?').run(email);
  return res.json({ message: 'Password reset successfully' });
});

app.get('/api/dashboard', auth, (req, res) => {
  const totalProducts = db.prepare('SELECT COALESCE(SUM(quantity), 0) AS value FROM stock').get().value;
  const lowStock = db.prepare(`
    SELECT COUNT(*) AS value FROM products p
    LEFT JOIN stock s ON s.product_id = p.id
    GROUP BY p.id HAVING COALESCE(SUM(s.quantity), 0) <= p.reorder_point
  `).all().length;
  const pending = type => db.prepare("SELECT COUNT(*) AS value FROM operations WHERE type = ? AND status NOT IN ('done', 'canceled')").get(type).value;
  return res.json({ totalProducts, lowStock, pendingReceipts: pending('receipt'), pendingDeliveries: pending('delivery'), scheduledTransfers: pending('transfer') });
});

app.get('/api/products', auth, (req, res) => {
  const products = db.prepare(`
    SELECT p.*, COALESCE(SUM(s.quantity), 0) AS totalStock
    FROM products p LEFT JOIN stock s ON s.product_id = p.id
    WHERE p.name LIKE @search OR p.sku LIKE @search
    GROUP BY p.id ORDER BY p.name
  `).all({ search: `%${req.query.search || ''}%` });
  return res.json(products);
});

app.post('/api/products', auth, (req, res) => {
  try {
    const { name, sku, category, uom, reorderPoint = 0, description = '', initialStock = 0, warehouseId = 1 } = req.body;
    if (!name || !sku || !category || !uom) return fail(res, 400, 'Name, SKU, category, and unit of measure are required');
    positiveInteger(Math.max(1, Number(warehouseId)), 'warehouseId');
    if (Number(initialStock) < 0 || !Number.isInteger(Number(initialStock))) return fail(res, 400, 'Initial stock must be a non-negative integer');
    const result = db.transaction(() => {
      const product = db.prepare('INSERT INTO products (name, sku, category, uom, reorder_point, description) VALUES (?, ?, ?, ?, ?, ?)').run(name.trim(), sku.trim(), category, uom, Number(reorderPoint) || 0, description);
      const productId = Number(product.lastInsertRowid);
      if (Number(initialStock) > 0) changeStock(productId, Number(warehouseId), Number(initialStock));
      return db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    })();
    return res.status(201).json(result);
  } catch (error) {
    return fail(res, error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 400, error.message);
  }
});

app.get('/api/warehouses', auth, (req, res) => res.json(db.prepare('SELECT * FROM warehouses ORDER BY name').all()));
app.get('/api/stock', auth, (req, res) => res.json(db.prepare(`
  SELECT s.product_id AS productId, s.warehouse_id AS warehouseId, s.quantity, p.name AS productName, p.sku, p.uom, w.name AS warehouseName
  FROM stock s JOIN products p ON p.id = s.product_id JOIN warehouses w ON w.id = s.warehouse_id ORDER BY p.name
`).all()));

app.post('/api/operations/receipts', auth, (req, res) => {
  try {
    const items = operationItems(req.body);
    const warehouseId = positiveInteger(req.body.warehouseId, 'warehouseId');
    const result = createOperation({ type: 'receipt', status: 'waiting', party: req.body.supplier, reference: req.body.reference, warehouseId, items, userId: req.user.id });
    return res.status(201).json(result);
  } catch (error) { return fail(res, 400, error.message); }
});

app.post('/api/operations/deliveries', auth, (req, res) => {
  try {
    const items = operationItems(req.body);
    const warehouseId = positiveInteger(req.body.warehouseId, 'warehouseId');
    items.forEach(item => { if (stockAt(item.productId, warehouseId) < item.quantity) throw new Error(`Insufficient stock for product ${item.productId}`); });
    const result = createOperation({ type: 'delivery', status: 'ready', party: req.body.customer, reference: req.body.reference, warehouseId, items, userId: req.user.id });
    return res.status(201).json(result);
  } catch (error) { return fail(res, 400, error.message); }
});

app.post('/api/operations/transfers', auth, (req, res) => {
  try {
    const items = operationItems(req.body);
    const fromWarehouseId = positiveInteger(req.body.fromWarehouseId, 'fromWarehouseId');
    const toWarehouseId = positiveInteger(req.body.toWarehouseId, 'toWarehouseId');
    if (fromWarehouseId === toWarehouseId) throw new Error('Source and destination must be different');
    items.forEach(item => { if (stockAt(item.productId, fromWarehouseId) < item.quantity) throw new Error(`Insufficient stock for product ${item.productId}`); });
    const result = createOperation({ type: 'transfer', status: 'waiting', fromWarehouseId, toWarehouseId, items, userId: req.user.id });
    return res.status(201).json(result);
  } catch (error) { return fail(res, 400, error.message); }
});

app.post('/api/operations/adjustments', auth, (req, res) => {
  try {
    const productId = positiveInteger(req.body.productId, 'productId');
    const warehouseId = positiveInteger(req.body.warehouseId, 'warehouseId');
    const newQuantity = Number(req.body.newQuantity);
    if (!Number.isInteger(newQuantity) || newQuantity < 0) throw new Error('newQuantity must be a non-negative integer');
    const oldQuantity = stockAt(productId, warehouseId);
    const operationId = id('ADJ');
    const result = db.transaction(() => {
      changeStock(productId, warehouseId, newQuantity - oldQuantity);
      db.prepare('INSERT INTO operations (id, type, status, warehouse_id, reason, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(operationId, 'adjustment', 'done', warehouseId, req.body.reason || 'count', req.body.notes || '', req.user.id);
      db.prepare('INSERT INTO operation_items (operation_id, product_id, quantity) VALUES (?, ?, ?)').run(operationId, productId, Math.max(1, Math.abs(newQuantity - oldQuantity)));
      return readOperation(operationId);
    })();
    return res.status(201).json({ ...result, oldQuantity, newQuantity });
  } catch (error) { return fail(res, 400, error.message); }
});

app.post('/api/operations/:id/validate', auth, (req, res) => {
  try {
    const operation = readOperation(req.params.id);
    if (!operation) return fail(res, 404, 'Operation not found');
    if (operation.status === 'done') return res.json(operation);
    const result = db.transaction(() => {
      if (operation.type === 'receipt') operation.items.forEach(item => changeStock(item.productId, operation.warehouse_id, item.quantity));
      if (operation.type === 'delivery') operation.items.forEach(item => changeStock(item.productId, operation.warehouse_id, -item.quantity));
      if (operation.type === 'transfer') operation.items.forEach(item => { changeStock(item.productId, operation.from_warehouse_id, -item.quantity); changeStock(item.productId, operation.to_warehouse_id, item.quantity); });
      db.prepare("UPDATE operations SET status = 'done' WHERE id = ?").run(operation.id);
      const ledger = db.prepare('INSERT INTO ledger (operation_id, product_id, warehouse_id, quantity_delta, note) VALUES (?, ?, ?, ?, ?)');
      operation.items.forEach(item => {
        if (operation.type === 'transfer') {
          ledger.run(operation.id, item.productId, operation.from_warehouse_id, -item.quantity, 'Transfer out');
          ledger.run(operation.id, item.productId, operation.to_warehouse_id, item.quantity, 'Transfer in');
        } else ledger.run(operation.id, item.productId, operation.warehouse_id, operation.type === 'delivery' ? -item.quantity : item.quantity, operation.type);
      });
      return readOperation(operation.id);
    })();
    return res.json(result);
  } catch (error) { return fail(res, 400, error.message); }
});

app.get('/api/operations', auth, (req, res) => res.json(db.prepare(`
  SELECT o.*, COUNT(oi.product_id) AS itemCount, COALESCE(SUM(oi.quantity), 0) AS totalQuantity
  FROM operations o LEFT JOIN operation_items oi ON oi.operation_id = o.id
  WHERE (@type = 'all' OR o.type = @type) AND (@status = 'all' OR o.status = @status)
  GROUP BY o.id ORDER BY o.created_at DESC
`).all({ type: req.query.type || 'all', status: req.query.status || 'all' })));

app.get('/api/ledger', auth, (req, res) => res.json(db.prepare(`
  SELECT l.*, p.name AS productName, p.sku, w.name AS warehouseName
  FROM ledger l JOIN products p ON p.id = l.product_id JOIN warehouses w ON w.id = l.warehouse_id
  ORDER BY l.created_at DESC
`).all()));

app.listen(port, () => console.log(`StockSense API listening on http://localhost:${port}`));
