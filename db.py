import sqlite3
import json
import os
from typing import Optional, List, Dict, Any

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'factory.sqlite')

def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    cursor = conn.cursor()
    cursor.executescript('''
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
            id TEXT PRIMARY KEY,
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
            status TEXT DEFAULT 'active',
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
            content_pool TEXT DEFAULT '[]',
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
            status TEXT DEFAULT 'pending',
            proof_file_id TEXT,
            invoice_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    ''')
    conn.commit()
    conn.close()

# Initialize tables immediately
init_db()

def dict_from_row(row) -> Optional[dict]:
    if row is None:
        return None
    return dict(row)

# Platform settings
def get_platform_setting(key: str) -> Optional[str]:
    conn = get_db()
    c = conn.cursor()
    c.execute('SELECT value FROM platform_settings WHERE key = ?', (key,))
    row = c.fetchone()
    conn.close()
    return row['value'] if row else None

def set_platform_setting(key: str, value: Any):
    conn = get_db()
    c = conn.cursor()
    c.execute('INSERT OR REPLACE INTO platform_settings (key, value) VALUES (?, ?)', (key, str(value)))
    conn.commit()
    conn.close()

# Platform Users
def get_platform_user(user_id: int, username: str = '', first_name: str = '') -> dict:
    conn = get_db()
    c = conn.cursor()
    c.execute('SELECT * FROM platform_users WHERE id = ?', (user_id,))
    row = c.fetchone()
    if not row:
        c.execute('INSERT INTO platform_users (id, username, first_name) VALUES (?, ?, ?)', (user_id, username, first_name))
        conn.commit()
        c.execute('SELECT * FROM platform_users WHERE id = ?', (user_id,))
        row = c.fetchone()
    res = dict(row)
    conn.close()
    return res

# Stores
def create_store(store_id: str, owner_id: int, bot_token: str, admin_id: int, bot_username: str, store_name: str = 'Магазин') -> dict:
    conn = get_db()
    c = conn.cursor()
    c.execute('''
        INSERT INTO stores (id, owner_id, bot_token, admin_id, bot_username, store_name)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (store_id, owner_id, bot_token, admin_id, bot_username, store_name))
    conn.commit()
    conn.close()
    return get_store(store_id)

def get_store(store_id: str) -> Optional[dict]:
    conn = get_db()
    c = conn.cursor()
    c.execute('SELECT * FROM stores WHERE id = ?', (store_id,))
    row = c.fetchone()
    conn.close()
    return dict_from_row(row)

def get_stores_by_owner(owner_id: int) -> List[dict]:
    conn = get_db()
    c = conn.cursor()
    c.execute('SELECT * FROM stores WHERE owner_id = ? ORDER BY created_at DESC', (owner_id,))
    rows = c.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_all_active_stores() -> List[dict]:
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM stores WHERE status = 'active'")
    rows = c.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def update_store_status(store_id: str, status: str):
    conn = get_db()
    c = conn.cursor()
    c.execute('UPDATE stores SET status = ? WHERE id = ?', (status, store_id))
    conn.commit()
    conn.close()

def delete_store(store_id: str):
    conn = get_db()
    c = conn.cursor()
    c.execute('DELETE FROM stores WHERE id = ?', (store_id,))
    c.execute('DELETE FROM products WHERE store_id = ?', (store_id,))
    c.execute('DELETE FROM categories WHERE store_id = ?', (store_id,))
    c.execute('DELETE FROM api_keys WHERE store_id = ?', (store_id,))
    conn.commit()
    conn.close()

def update_store_setting(store_id: str, field: str, value: Any):
    allowed = ['store_name', 'usdt_rate', 'card_requisites', 'sbp_requisites', 'cryptobot_token', 'xrocket_token', 'support_contact', 'reviews_enabled']
    if field not in allowed:
        return
    conn = get_db()
    c = conn.cursor()
    c.execute(f'UPDATE stores SET {field} = ? WHERE id = ?', (value, store_id))
    conn.commit()
    conn.close()

# API Keys
def create_api_key(key: str, owner_id: int, name: str = 'Developer Key') -> dict:
    conn = get_db()
    c = conn.cursor()
    c.execute('INSERT OR REPLACE INTO api_keys (key, owner_id, name) VALUES (?, ?, ?)', (key, owner_id, name))
    conn.commit()
    conn.close()
    return {'key': key, 'owner_id': owner_id, 'name': name}

def get_api_keys(owner_id: int) -> List[dict]:
    conn = get_db()
    c = conn.cursor()
    c.execute('SELECT * FROM api_keys WHERE owner_id = ? ORDER BY created_at DESC', (owner_id,))
    rows = c.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_api_key_info(key: str) -> Optional[dict]:
    conn = get_db()
    c = conn.cursor()
    c.execute('SELECT * FROM api_keys WHERE key = ?', (key,))
    row = c.fetchone()
    conn.close()
    return dict_from_row(row)

def delete_api_key(key: str):
    conn = get_db()
    c = conn.cursor()
    c.execute('DELETE FROM api_keys WHERE key = ?', (key,))
    conn.commit()
    conn.close()

# Store Customers
def get_store_user(store_id: str, user_id: int, username: str = '', first_name: str = '') -> dict:
    conn = get_db()
    c = conn.cursor()
    c.execute('SELECT * FROM store_users WHERE store_id = ? AND id = ?', (store_id, user_id))
    row = c.fetchone()
    if not row:
        c.execute('INSERT INTO store_users (id, store_id, username, first_name, balance) VALUES (?, ?, ?, ?, 0)', (user_id, store_id, username, first_name))
        conn.commit()
        c.execute('SELECT * FROM store_users WHERE store_id = ? AND id = ?', (store_id, user_id))
        row = c.fetchone()
    elif username or first_name:
        c.execute('UPDATE store_users SET username = ?, first_name = ? WHERE store_id = ? AND id = ?', (username, first_name, store_id, user_id))
        conn.commit()
        c.execute('SELECT * FROM store_users WHERE store_id = ? AND id = ?', (store_id, user_id))
        row = c.fetchone()
    res = dict(row)
    conn.close()
    return res

def update_store_user_balance(store_id: str, user_id: int, delta: float) -> float:
    conn = get_db()
    c = conn.cursor()
    c.execute('UPDATE store_users SET balance = balance + ? WHERE store_id = ? AND id = ?', (delta, store_id, user_id))
    conn.commit()
    c.execute('SELECT balance FROM store_users WHERE store_id = ? AND id = ?', (store_id, user_id))
    row = c.fetchone()
    val = row['balance'] if row else 0.0
    conn.close()
    return val

# Catalog
def get_categories(store_id: str) -> List[dict]:
    conn = get_db()
    c = conn.cursor()
    c.execute('SELECT * FROM categories WHERE store_id = ? ORDER BY id ASC', (store_id,))
    rows = c.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def add_category(store_id: str, title: str):
    conn = get_db()
    c = conn.cursor()
    c.execute('INSERT INTO categories (store_id, title) VALUES (?, ?)', (store_id, title))
    conn.commit()
    conn.close()

def delete_category(store_id: str, cat_id: int):
    conn = get_db()
    c = conn.cursor()
    c.execute('DELETE FROM categories WHERE store_id = ? AND id = ?', (store_id, cat_id))
    conn.commit()
    conn.close()

def get_products(store_id: str, category_id: Optional[int] = None) -> List[dict]:
    conn = get_db()
    c = conn.cursor()
    if category_id:
        c.execute('SELECT * FROM products WHERE store_id = ? AND category_id = ? ORDER BY id DESC', (store_id, category_id))
    else:
        c.execute('''
            SELECT p.*, c.title as category_title 
            FROM products p 
            LEFT JOIN categories c ON p.category_id = c.id 
            WHERE p.store_id = ? 
            ORDER BY p.id DESC
        ''', (store_id,))
    rows = c.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_product(store_id: str, prod_id: int) -> Optional[dict]:
    conn = get_db()
    c = conn.cursor()
    c.execute('SELECT * FROM products WHERE store_id = ? AND id = ?', (store_id, prod_id))
    row = c.fetchone()
    conn.close()
    return dict_from_row(row)

def add_product(store_id: str, category_id: int, title: str, description: str, price: float, pool: list = None, image_url: Optional[str] = None):
    if pool is None:
        pool = []
    conn = get_db()
    c = conn.cursor()
    c.execute('''
        INSERT INTO products (store_id, category_id, title, description, price, content_pool, image_url)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (store_id, category_id, title, description, price, json.dumps(pool, ensure_ascii=False), image_url))
    conn.commit()
    conn.close()

def update_product_pool(store_id: str, prod_id: int, pool: list):
    conn = get_db()
    c = conn.cursor()
    c.execute('UPDATE products SET content_pool = ? WHERE store_id = ? AND id = ?', (json.dumps(pool, ensure_ascii=False), store_id, prod_id))
    conn.commit()
    conn.close()

def delete_product(store_id: str, prod_id: int):
    conn = get_db()
    c = conn.cursor()
    c.execute('DELETE FROM products WHERE store_id = ? AND id = ?', (store_id, prod_id))
    conn.commit()
    conn.close()

# Purchases
def add_purchase(store_id: str, user_id: int, product_id: int, product_title: str, price: float, delivered_content: str):
    conn = get_db()
    c = conn.cursor()
    c.execute('''
        INSERT INTO purchases (store_id, user_id, product_id, product_title, price, delivered_content)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (store_id, user_id, product_id, product_title, price, delivered_content))
    conn.commit()
    conn.close()

def has_user_purchased_product(store_id: str, user_id: int, product_id: int) -> bool:
    conn = get_db()
    c = conn.cursor()
    c.execute('SELECT 1 FROM purchases WHERE store_id = ? AND user_id = ? AND product_id = ? LIMIT 1', (store_id, user_id, product_id))
    row = c.fetchone()
    conn.close()
    return row is not None

def get_user_purchases(store_id: str, user_id: int) -> List[dict]:
    conn = get_db()
    c = conn.cursor()
    c.execute('SELECT * FROM purchases WHERE store_id = ? AND user_id = ? ORDER BY id DESC', (store_id, user_id))
    rows = c.fetchall()
    conn.close()
    return [dict(r) for r in rows]

# Reviews
def add_review(store_id: str, product_id: int, user_id: int, user_name: str, rating: int, comment: str):
    conn = get_db()
    c = conn.cursor()
    c.execute('''
        INSERT INTO reviews (store_id, product_id, user_id, user_name, rating, comment)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (store_id, product_id, user_id, user_name, rating, comment))
    conn.commit()
    conn.close()

def get_product_reviews(store_id: str, product_id: int) -> List[dict]:
    conn = get_db()
    c = conn.cursor()
    c.execute('SELECT * FROM reviews WHERE store_id = ? AND product_id = ? ORDER BY id DESC', (store_id, product_id))
    rows = c.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_product_rating(store_id: str, product_id: int) -> dict:
    conn = get_db()
    c = conn.cursor()
    c.execute('SELECT AVG(rating) as avg, COUNT(*) as count FROM reviews WHERE store_id = ? AND product_id = ?', (store_id, product_id))
    res = c.fetchone()
    conn.close()
    avg = round(res['avg'], 1) if res and res['avg'] is not None else 0.0
    cnt = res['count'] if res else 0
    return {'average': avg, 'count': cnt}

# Deposits
def create_deposit(store_id: str, user_id: int, amount: float, method: str, proof_file_id: Optional[str] = None, invoice_id: Optional[str] = None) -> int:
    conn = get_db()
    c = conn.cursor()
    c.execute('''
        INSERT INTO deposits (store_id, user_id, amount, method, status, proof_file_id, invoice_id)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
    ''', (store_id, user_id, amount, method, proof_file_id, invoice_id))
    conn.commit()
    dep_id = c.lastrowid
    conn.close()
    return dep_id

def get_deposit(store_id: str, dep_id: int) -> Optional[dict]:
    conn = get_db()
    c = conn.cursor()
    c.execute('SELECT * FROM deposits WHERE store_id = ? AND id = ?', (store_id, dep_id))
    row = c.fetchone()
    conn.close()
    return dict_from_row(row)

def update_deposit_status(store_id: str, dep_id: int, status: str):
    conn = get_db()
    c = conn.cursor()
    c.execute('UPDATE deposits SET status = ? WHERE store_id = ? AND id = ?', (status, store_id, dep_id))
    conn.commit()
    conn.close()

def get_store_stats(store_id: str) -> dict:
    conn = get_db()
    c = conn.cursor()
    c.execute('SELECT COUNT(*) as c FROM store_users WHERE store_id = ?', (store_id,))
    users = c.fetchone()['c']

    c.execute('SELECT COUNT(*) as c, COALESCE(SUM(price), 0) as s FROM purchases WHERE store_id = ?', (store_id,))
    orders_row = c.fetchone()

    c.execute("SELECT COUNT(*) as c, COALESCE(SUM(amount), 0) as s FROM deposits WHERE store_id = ? AND status = 'approved'", (store_id,))
    dep_row = c.fetchone()

    c.execute('SELECT COUNT(*) as c FROM products WHERE store_id = ?', (store_id,))
    products_count = c.fetchone()['c']

    c.execute("SELECT COUNT(*) as c FROM deposits WHERE store_id = ? AND status = 'pending'", (store_id,))
    pending_deposits = c.fetchone()['c']

    conn.close()
    return {
        'users': users,
        'ordersCount': orders_row['c'],
        'ordersVolume': round(orders_row['s'], 2),
        'depositsCount': dep_row['c'],
        'depositsVolume': round(dep_row['s'], 2),
        'productsCount': products_count,
        'pendingDeposits': pending_deposits
    }
