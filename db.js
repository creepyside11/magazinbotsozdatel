const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    balance REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    image_url TEXT,
    content_pool TEXT DEFAULT '[]', -- JSON array of items/keys
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    product_id INTEGER,
    product_title TEXT NOT NULL,
    price REAL NOT NULL,
    delivered_content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    method TEXT NOT NULL, -- card, sbp, cryptobot, xrocket
    status TEXT DEFAULT 'pending', -- pending, approved, rejected
    proof_file_id TEXT,
    invoice_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

function initDefaultSettings() {
  const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setStmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  const defaults = {
    store_name: 'TERMINAL STORE',
    usdt_rate: '95',
    card_requisites: '2202 2000 0000 0000 (Сбербанк / Тинькофф, Получатель: Иван И.)',
    sbp_requisites: '+7 999 000-00-00 (Т-Банк / СБП, Иван И.)',
    cryptobot_token: '',
    xrocket_token: '',
    support_contact: '@admin',
    privacy_policy_url: '',
    terms_of_service_url: '',
    ref_system_enabled: '1', // '1' or '0'
    ref_reward_percent: '10', // 10%
    reviews_enabled: '1', // '1' or '0'
    miniapp_url: ''
  };

  for (const [key, value] of Object.entries(defaults)) {
    const existing = getStmt.get(key);
    if (!existing) {
      setStmt.run(key, value);
    }
  }
}
initDefaultSettings();

module.exports = {
  db,
  getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },
  setSetting(key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
  },
  getAllSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const res = {};
    for (const r of rows) res[r.key] = r.value;
    return res;
  },
  getUser(id, username = '', first_name = '', referrerId = null) {
    let user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) {
      db.prepare('INSERT INTO users (id, username, first_name, balance, referrer_id) VALUES (?, ?, ?, 0, ?)').run(
        id, username, first_name, referrerId && referrerId !== id ? referrerId : null
      );
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    } else if (username || first_name) {
      db.prepare('UPDATE users SET username = ?, first_name = ? WHERE id = ?').run(username, first_name, id);
    }
    return user;
  },
  getReferrals(userId) {
    return db.prepare('SELECT * FROM users WHERE referrer_id = ?').all(userId);
  },
  updateUserBalance(id, delta) {
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(delta, id);
    return db.prepare('SELECT balance FROM users WHERE id = ?').get(id)?.balance || 0;
  },
  getCategories() {
    return db.prepare('SELECT * FROM categories ORDER BY id ASC').all();
  },
  addCategory(title) {
    return db.prepare('INSERT INTO categories (title) VALUES (?)').run(title);
  },
  deleteCategory(id) {
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  },
  getProducts(categoryId = null) {
    if (categoryId) {
      return db.prepare('SELECT * FROM products WHERE category_id = ? ORDER BY id DESC').all(categoryId);
    }
    return db.prepare('SELECT p.*, c.title as category_title FROM products p LEFT JOIN categories c ON p.category_id = c.id ORDER BY p.id DESC').all();
  },
  getProduct(id) {
    return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  },
  addProduct(categoryId, title, description, price, pool = [], imageUrl = null) {
    return db.prepare('INSERT INTO products (category_id, title, description, price, content_pool, image_url) VALUES (?, ?, ?, ?, ?, ?)').run(
      categoryId,
      title,
      description,
      price,
      JSON.stringify(pool),
      imageUrl
    );
  },
  updateProductPool(id, pool) {
    db.prepare('UPDATE products SET content_pool = ? WHERE id = ?').run(JSON.stringify(pool), id);
  },
  deleteProduct(id) {
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
  },
  addPurchase(userId, productId, productTitle, price, deliveredContent) {
    return db.prepare('INSERT INTO purchases (user_id, product_id, product_title, price, delivered_content) VALUES (?, ?, ?, ?, ?)').run(
      userId,
      productId,
      productTitle,
      price,
      deliveredContent
    );
  },
  hasUserPurchasedProduct(userId, productId) {
    const row = db.prepare('SELECT 1 FROM purchases WHERE user_id = ? AND product_id = ? LIMIT 1').get(userId, productId);
    return !!row;
  },
  getUserPurchases(userId) {
    return db.prepare('SELECT * FROM purchases WHERE user_id = ? ORDER BY id DESC').all(userId);
  },
  createDeposit(userId, amount, method, proofFileId = null, invoiceId = null) {
    return db.prepare("INSERT INTO deposits (user_id, amount, method, status, proof_file_id, invoice_id) VALUES (?, ?, ?, 'pending', ?, ?)").run(
      userId,
      amount,
      method,
      proofFileId,
      invoiceId
    );
  },
  getDeposit(id) {
    return db.prepare('SELECT * FROM deposits WHERE id = ?').get(id);
  },
  updateDepositStatus(id, status) {
    db.prepare('UPDATE deposits SET status = ? WHERE id = ?').run(status, id);
  },
  // Promo codes
  createPromoCode(code, reward, maxUses = 1) {
    return db.prepare('INSERT INTO promo_codes (code, reward, max_uses) VALUES (?, ?, ?)').run(code.toUpperCase(), reward, maxUses);
  },
  getPromoCodes() {
    return db.prepare('SELECT * FROM promo_codes ORDER BY id DESC').all();
  },
  deletePromoCode(id) {
    db.prepare('DELETE FROM promo_codes WHERE id = ?').run(id);
    db.prepare('DELETE FROM promo_activations WHERE promo_id = ?').run(id);
  },
  activatePromoCode(userId, code) {
    const promo = db.prepare('SELECT * FROM promo_codes WHERE code = ?').get(code.toUpperCase());
    if (!promo) return { ok: false, error: 'Промокод не найден' };

    if (promo.used_count >= promo.max_uses) {
      return { ok: false, error: 'Лимит активаций этого промокода исчерпан' };
    }

    const already = db.prepare('SELECT id FROM promo_activations WHERE promo_id = ? AND user_id = ?').get(promo.id, userId);
    if (already) {
      return { ok: false, error: 'Вы уже активировали этот промокод ранее' };
    }

    db.prepare('INSERT INTO promo_activations (promo_id, user_id) VALUES (?, ?)').run(promo.id, userId);
    db.prepare('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = ?').run(promo.id);
    const newBal = this.updateUserBalance(userId, promo.reward);

    return { ok: true, reward: promo.reward, balance: newBal };
  },

  // Reviews
  addReview(productId, userId, userName, rating, comment) {
    return db.prepare('INSERT INTO reviews (product_id, user_id, user_name, rating, comment) VALUES (?, ?, ?, ?, ?)').run(
      productId, userId, userName, rating, comment
    );
  },
  getProductReviews(productId) {
    return db.prepare('SELECT * FROM reviews WHERE product_id = ? ORDER BY id DESC').all(productId);
  },
  getProductRating(productId) {
    const res = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as count FROM reviews WHERE product_id = ?').get(productId);
    return {
      average: res.avg ? Number(res.avg.toFixed(1)) : 0,
      count: res.count || 0
    };
  },

  getAllUsers() {
    return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  },
  getUserById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },
  getStats() {
    const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const totalPurchases = db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(price), 0) as s FROM purchases').get();
    const approvedDeposits = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(amount), 0) as s FROM deposits WHERE status = 'approved'").get();
    const totalProducts = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
    const pendingDeposits = db.prepare("SELECT COUNT(*) as c FROM deposits WHERE status = 'pending'").get().c;

    // Today stats
    const todayOrders = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(price), 0) as s FROM purchases WHERE date(created_at) = date('now')").get();
    const todayDeposits = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(amount), 0) as s FROM deposits WHERE status = 'approved' AND date(created_at) = date('now')").get();

    return {
      users: totalUsers,
      ordersCount: totalPurchases.c,
      ordersVolume: totalPurchases.s,
      depositsCount: approvedDeposits.c,
      depositsVolume: approvedDeposits.s,
      pendingDeposits,
      todayOrdersCount: todayOrders.c,
      todayOrdersVolume: todayOrders.s,
      todayDepositsVolume: todayDeposits.s,
      productsCount: totalProducts
    };
  }
};
