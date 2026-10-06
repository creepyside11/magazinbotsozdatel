const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, 'factory.sqlite');
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  -- Platform global settings
  CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- Developers / Users of the platform
  CREATE TABLE IF NOT EXISTS platform_users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Stores created by developers
  CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY, -- unique slug / uuid
    owner_id INTEGER NOT NULL,
    bot_token TEXT NOT NULL,
    bot_username TEXT,
    admin_id INTEGER NOT NULL,
    store_name TEXT DEFAULT 'Магазин',
    usdt_rate REAL DEFAULT 95,
    card_requisites TEXT DEFAULT '',
    sbp_requisites TEXT DEFAULT '',
    cryptobot_token TEXT DEFAULT '',
    xrocket_token TEXT DEFAULT '',
    support_contact TEXT DEFAULT '',
    reviews_enabled INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active', -- active, stopped
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- API Keys for external developers
  CREATE TABLE IF NOT EXISTS api_keys (
    key TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    name TEXT DEFAULT 'Developer Key',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Categories per store
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Products per store
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL,
    category_id INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    image_url TEXT,
    content_pool TEXT DEFAULT '[]', -- JSON array of keys/items
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Store customers
  CREATE TABLE IF NOT EXISTS store_users (
    id INTEGER NOT NULL,
    store_id TEXT NOT NULL,
    username TEXT,
    first_name TEXT,
    balance REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(id, store_id)
  );

  -- Orders / Purchases per store
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    product_id INTEGER,
    product_title TEXT NOT NULL,
    price REAL NOT NULL,
    delivered_content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Product reviews
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    user_name TEXT,
    rating INTEGER NOT NULL,
    comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Deposits per store
  CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    method TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- pending, approved, rejected
    proof_file_id TEXT,
    invoice_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = {
  db,
  getPlatformSetting(key) {
    const row = db.prepare('SELECT value FROM platform_settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },
  setPlatformSetting(key, value) {
    db.prepare('INSERT OR REPLACE INTO platform_settings (key, value) VALUES (?, ?)').run(key, String(value));
  },
  getPlatformUser(id, username = '', first_name = '') {
    let u = db.prepare('SELECT * FROM platform_users WHERE id = ?').get(id);
    if (!u) {
      db.prepare('INSERT INTO platform_users (id, username, first_name) VALUES (?, ?, ?)').run(id, username, first_name);
      u = db.prepare('SELECT * FROM platform_users WHERE id = ?').get(id);
    }
    return u;
  },
  createStore(id, ownerId, botToken, adminId, botUsername, storeName = 'Магазин') {
    db.prepare(`
      INSERT INTO stores (id, owner_id, bot_token, admin_id, bot_username, store_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, ownerId, botToken, adminId, botUsername, storeName);
    return this.getStore(id);
  },
  getStore(id) {
    return db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  },
  getStoresByOwner(ownerId) {
    return db.prepare('SELECT * FROM stores WHERE owner_id = ? ORDER BY created_at DESC').all(ownerId);
  },
  getAllActiveStores() {
    return db.prepare("SELECT * FROM stores WHERE status = 'active'").all();
  },
  updateStoreStatus(id, status) {
    db.prepare('UPDATE stores SET status = ? WHERE id = ?').run(status, id);
  },
  deleteStore(id) {
    db.prepare('DELETE FROM stores WHERE id = ?').run(id);
    db.prepare('DELETE FROM products WHERE store_id = ?').run(id);
    db.prepare('DELETE FROM categories WHERE store_id = ?').run(id);
    db.prepare('DELETE FROM api_keys WHERE store_id = ?').run(id);
  },
  updateStoreSetting(id, field, value) {
    const allowed = ['store_name', 'usdt_rate', 'card_requisites', 'sbp_requisites', 'cryptobot_token', 'xrocket_token', 'support_contact', 'reviews_enabled'];
    if (!allowed.includes(field)) return;
    db.prepare(`UPDATE stores SET ${field} = ? WHERE id = ?`).run(value, id);
  },
  // API Keys
  createApiKey(key, ownerId, name = 'Developer Key') {
    db.prepare('INSERT OR REPLACE INTO api_keys (key, owner_id, name) VALUES (?, ?, ?)').run(key, ownerId, name);
    return { key, ownerId, name };
  },
  getApiKeys(ownerId) {
    return db.prepare('SELECT * FROM api_keys WHERE owner_id = ? ORDER BY created_at DESC').all(ownerId);
  },
  getApiKeyInfo(key) {
    return db.prepare('SELECT * FROM api_keys WHERE key = ?').get(key);
  },
  deleteApiKey(key) {
    db.prepare('DELETE FROM api_keys WHERE key = ?').run(key);
  },
  // Store Customers
  getStoreUser(storeId, userId, username = '', first_name = '') {
    let u = db.prepare('SELECT * FROM store_users WHERE store_id = ? AND id = ?').get(storeId, userId);
    if (!u) {
      db.prepare('INSERT INTO store_users (id, store_id, username, first_name, balance) VALUES (?, ?, ?, ?, 0)').run(userId, storeId, username, first_name);
      u = db.prepare('SELECT * FROM store_users WHERE store_id = ? AND id = ?').get(storeId, userId);
    } else if (username || first_name) {
      db.prepare('UPDATE store_users SET username = ?, first_name = ? WHERE store_id = ? AND id = ?').run(username, first_name, storeId, userId);
    }
    return u;
  },
  updateStoreUserBalance(storeId, userId, delta) {
    db.prepare('UPDATE store_users SET balance = balance + ? WHERE store_id = ? AND id = ?').run(delta, storeId, userId);
    return db.prepare('SELECT balance FROM store_users WHERE store_id = ? AND id = ?').get(storeId, userId)?.balance || 0;
  },
  // Store Catalog
  getCategories(storeId) {
    return db.prepare('SELECT * FROM categories WHERE store_id = ? ORDER BY id ASC').all(storeId);
  },
  addCategory(storeId, title) {
    return db.prepare('INSERT INTO categories (store_id, title) VALUES (?, ?)').run(storeId, title);
  },
  deleteCategory(storeId, id) {
    db.prepare('DELETE FROM categories WHERE store_id = ? AND id = ?').run(storeId, id);
  },
  getProducts(storeId, categoryId = null) {
    if (categoryId) {
      return db.prepare('SELECT * FROM products WHERE store_id = ? AND category_id = ? ORDER BY id DESC').all(storeId, categoryId);
    }
    return db.prepare('SELECT p.*, c.title as category_title FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.store_id = ? ORDER BY p.id DESC').all(storeId);
  },
  getProduct(storeId, id) {
    return db.prepare('SELECT * FROM products WHERE store_id = ? AND id = ?').get(storeId, id);
  },
  addProduct(storeId, categoryId, title, description, price, pool = [], imageUrl = null) {
    return db.prepare(`
      INSERT INTO products (store_id, category_id, title, description, price, content_pool, image_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(storeId, categoryId, title, description, price, JSON.stringify(pool), imageUrl);
  },
  updateProductPool(storeId, id, pool) {
    db.prepare('UPDATE products SET content_pool = ? WHERE store_id = ? AND id = ?').run(JSON.stringify(pool), storeId, id);
  },
  deleteProduct(storeId, id) {
    db.prepare('DELETE FROM products WHERE store_id = ? AND id = ?').run(storeId, id);
  },
  // Purchases
  addPurchase(storeId, userId, productId, productTitle, price, deliveredContent) {
    return db.prepare(`
      INSERT INTO purchases (store_id, user_id, product_id, product_title, price, delivered_content)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(storeId, userId, productId, productTitle, price, deliveredContent);
  },
  hasUserPurchasedProduct(storeId, userId, productId) {
    const row = db.prepare('SELECT 1 FROM purchases WHERE store_id = ? AND user_id = ? AND product_id = ? LIMIT 1').get(storeId, userId, productId);
    return !!row;
  },
  getUserPurchases(storeId, userId) {
    return db.prepare('SELECT * FROM purchases WHERE store_id = ? AND user_id = ? ORDER BY id DESC').all(storeId, userId);
  },
  // Reviews
  addReview(storeId, productId, userId, userName, rating, comment) {
    return db.prepare(`
      INSERT INTO reviews (store_id, product_id, user_id, user_name, rating, comment)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(storeId, productId, userId, userName, rating, comment);
  },
  getProductReviews(storeId, productId) {
    return db.prepare('SELECT * FROM reviews WHERE store_id = ? AND product_id = ? ORDER BY id DESC').all(storeId, productId);
  },
  getProductRating(storeId, productId) {
    const res = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as count FROM reviews WHERE store_id = ? AND product_id = ?').get(storeId, productId);
    return {
      average: res.avg ? Number(res.avg.toFixed(1)) : 0,
      count: res.count || 0
    };
  },
  // Deposits
  createDeposit(storeId, userId, amount, method, proofFileId = null, invoiceId = null) {
    return db.prepare(`
      INSERT INTO deposits (store_id, user_id, amount, method, status, proof_file_id, invoice_id)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(storeId, userId, amount, method, proofFileId, invoiceId);
  },
  getDeposit(storeId, id) {
    return db.prepare('SELECT * FROM deposits WHERE store_id = ? AND id = ?').get(storeId, id);
  },
  updateDepositStatus(storeId, id, status) {
    db.prepare('UPDATE deposits SET status = ? WHERE store_id = ? AND id = ?').run(status, storeId, id);
  },
  getStoreStats(storeId) {
    const users = db.prepare('SELECT COUNT(*) as c FROM store_users WHERE store_id = ?').get(storeId).c;
    const orders = db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(price), 0) as s FROM purchases WHERE store_id = ?').get(storeId);
    const deposits = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(amount), 0) as s FROM deposits WHERE store_id = ? AND status = 'approved'").get(storeId);
    const productsCount = db.prepare('SELECT COUNT(*) as c FROM products WHERE store_id = ?').get(storeId).c;
    const pendingDeposits = db.prepare("SELECT COUNT(*) as c FROM deposits WHERE store_id = ? AND status = 'pending'").get(storeId).c;
    return {
      users,
      ordersCount: orders.c,
      ordersVolume: orders.s,
      depositsCount: deposits.c,
      depositsVolume: deposits.s,
      productsCount,
      pendingDeposits
    };
  }
};
