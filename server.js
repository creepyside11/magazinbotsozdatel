const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');

function createServer(getBaseUrl) {
  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    const sendJson = (data, status = 200) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key'
      });
      res.end(JSON.stringify(data));
    };

    const readBody = () => new Promise((resolve) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); }
        catch (e) { resolve({}); }
      });
    });

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key'
      });
      return res.end();
    }

    // Serve Static Mini App
    if (pathname === '/app' || pathname === '/app/') {
      const file = path.join(__dirname, 'public', 'app', 'index.html');
      if (fs.existsSync(file)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return fs.createReadStream(file).pipe(res);
      }
    }

    // Serve Developer Documentation Page
    if (pathname === '/docs' || pathname === '/docs/') {
      const file = path.join(__dirname, 'public', 'docs', 'index.html');
      if (fs.existsSync(file)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return fs.createReadStream(file).pipe(res);
      }
    }

    // Static Assets
    if (req.method === 'GET' && (pathname.startsWith('/app/') || pathname.startsWith('/docs/'))) {
      const filePath = path.join(__dirname, 'public', pathname);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const mimes = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
        res.writeHead(200, { 'Content-Type': mimes[ext] || 'text/plain' });
        return fs.createReadStream(filePath).pipe(res);
      }
    }

    // ==========================================
    // STORE MINI APP API ENDPOINTS (/api/store/...)
    // ==========================================
    if (pathname === '/api/store/info' && req.method === 'GET') {
      const storeId = urlObj.searchParams.get('shop');
      if (!storeId) return sendJson({ ok: false, error: 'Shop ID required' }, 400);
      const store = db.getStore(storeId);
      if (!store) return sendJson({ ok: false, error: 'Shop not found' }, 404);

      return sendJson({
        ok: true,
        store: {
          id: store.id,
          name: store.store_name,
          support: store.support_contact,
          reviews_enabled: store.reviews_enabled !== 0
        }
      });
    }

    if (pathname === '/api/store/user' && req.method === 'GET') {
      const storeId = urlObj.searchParams.get('shop');
      const userId = parseInt(urlObj.searchParams.get('userId'));
      const username = urlObj.searchParams.get('username') || '';
      const firstName = urlObj.searchParams.get('first_name') || '';
      if (!storeId || !userId) return sendJson({ ok: false, error: 'Parameters missing' }, 400);

      const user = db.getStoreUser(storeId, userId, username, firstName);
      return sendJson({ ok: true, user });
    }

    if (pathname === '/api/store/catalog' && req.method === 'GET') {
      const storeId = urlObj.searchParams.get('shop');
      if (!storeId) return sendJson({ ok: false, error: 'Shop ID required' }, 400);

      const categories = db.getCategories(storeId);
      const products = db.getProducts(storeId).map(p => {
        const rating = db.getProductRating(storeId, p.id);
        return { ...p, rating };
      });

      return sendJson({ ok: true, categories, products });
    }

    if (pathname === '/api/store/reviews' && req.method === 'GET') {
      const storeId = urlObj.searchParams.get('shop');
      const productId = parseInt(urlObj.searchParams.get('productId'));
      const userId = parseInt(urlObj.searchParams.get('userId'));
      if (!storeId || !productId) return sendJson({ ok: false, error: 'Missing parameters' }, 400);

      const store = db.getStore(storeId);
      if (!store || store.reviews_enabled === 0) {
        return sendJson({ ok: true, reviews: [], rating: { average: 0, count: 0 }, canReview: false, reviews_enabled: false });
      }

      const reviews = db.getProductReviews(storeId, productId);
      const rating = db.getProductRating(storeId, productId);
      const canReview = userId ? db.hasUserPurchasedProduct(storeId, userId, productId) : false;

      return sendJson({ ok: true, reviews, rating, canReview, reviews_enabled: true });
    }

    if (pathname === '/api/store/review' && req.method === 'POST') {
      const body = await readBody();
      const { storeId, productId, userId, userName, rating, comment } = body;
      if (!storeId || !productId || !userId || !rating) return sendJson({ ok: false, error: 'Missing parameters' }, 400);

      const store = db.getStore(storeId);
      if (!store || store.reviews_enabled === 0) {
        return sendJson({ ok: false, error: 'Система отзывов отключена в данном магазине' }, 403);
      }

      const hasBought = db.hasUserPurchasedProduct(storeId, userId, productId);
      if (!hasBought) {
        return sendJson({ ok: false, error: 'Для оставления отзыва необходимо сначала купить этот товар' }, 403);
      }

      db.addReview(storeId, productId, userId, userName || 'Покупатель', rating, comment || '');
      return sendJson({ ok: true });
    }

    if (pathname === '/api/store/purchase' && req.method === 'POST') {
      const body = await readBody();
      const { storeId, userId, productId } = body;
      if (!storeId || !userId || !productId) return sendJson({ ok: false, error: 'Missing parameters' }, 400);

      const user = db.getStoreUser(storeId, userId);
      const prod = db.getProduct(storeId, productId);
      if (!prod) return sendJson({ ok: false, error: 'Товар не найден' }, 404);

      let pool = [];
      try { pool = JSON.parse(prod.content_pool || '[]'); } catch(e) {}
      if (pool.length === 0) return sendJson({ ok: false, error: 'Товара нет в наличии' }, 400);
      if (user.balance < prod.price) return sendJson({ ok: false, error: 'Недостаточно средств на балансе' }, 400);

      const delivered = pool.shift();
      db.updateStoreUserBalance(storeId, userId, -prod.price);
      db.updateProductPool(storeId, productId, pool);
      db.addPurchase(storeId, userId, productId, prod.title, prod.price, delivered);

      return sendJson({ ok: true, delivered });
    }

    if (pathname === '/api/store/orders' && req.method === 'GET') {
      const storeId = urlObj.searchParams.get('shop');
      const userId = parseInt(urlObj.searchParams.get('userId'));
      if (!storeId || !userId) return sendJson({ ok: false, error: 'Missing parameters' }, 400);

      const orders = db.getUserPurchases(storeId, userId);
      return sendJson({ ok: true, orders });
    }

    // ==========================================
    // DEVELOPER PUBLIC REST API (/api/v1/...)
    // Authenticated via Header: Authorization: Bearer <key> OR X-API-Key: <key>
    // ==========================================
    if (pathname.startsWith('/api/v1/')) {
      const authHeader = req.headers['authorization'] || '';
      const apiKeyHeader = req.headers['x-api-key'] || '';
      let rawKey = apiKeyHeader;
      if (!rawKey && authHeader.startsWith('Bearer ')) {
        rawKey = authHeader.replace('Bearer ', '').trim();
      }

      if (!rawKey) {
        return sendJson({ ok: false, error: 'Unauthorized: API Key missing' }, 401);
      }

      const keyInfo = db.getApiKeyInfo(rawKey);
      if (!keyInfo) {
        return sendJson({ ok: false, error: 'Unauthorized: Invalid API Key' }, 403);
      }

      const ownerId = keyInfo.owner_id;

      // GET /api/v1/stores - List all stores owned by developer
      if (pathname === '/api/v1/stores' && req.method === 'GET') {
        const stores = db.getStoresByOwner(ownerId);
        return sendJson({ ok: true, count: stores.length, stores });
      }

      // POST /api/v1/stores - Create & launch a new bot-store programmatically!
      if (pathname === '/api/v1/stores' && req.method === 'POST') {
        const body = await readBody();
        const { botToken, adminId, storeName } = body;
        if (!botToken || !adminId) {
          return sendJson({ ok: false, error: 'botToken and adminId are required' }, 400);
        }

        // Verify botToken via Telegram API
        try {
          const { Telegraf } = require('telegraf');
          const testBot = new Telegraf(botToken);
          const me = await testBot.telegram.getMe();

          const crypto = require('crypto');
          const storeId = 'shop_' + crypto.randomBytes(4).toString('hex');
          const name = storeName || me.first_name || 'Магазин';

          const newStore = db.createStore(storeId, ownerId, botToken, parseInt(adminId), me.username, name);

          // Launch bot
          const { startStoreBot, getPublicMiniAppUrl } = require('./botManager');
          await startStoreBot(newStore, getBaseUrl);

          const appUrl = getPublicMiniAppUrl(storeId, getBaseUrl());

          return sendJson({
            ok: true,
            storeId,
            botUsername: me.username,
            storeName: name,
            miniAppUrl: appUrl
          });
        } catch (err) {
          return sendJson({ ok: false, error: 'Failed to verify or launch bot token: ' + err.message }, 400);
        }
      }

      // DELETE /api/v1/stores/:id - Delete bot-store
      if (pathname.startsWith('/api/v1/stores/') && req.method === 'DELETE') {
        const storeId = pathname.replace('/api/v1/stores/', '').trim();
        const s = db.getStore(storeId);
        if (!s || s.owner_id !== ownerId) {
          return sendJson({ ok: false, error: 'Store not found' }, 404);
        }
        const { stopStoreBot } = require('./botManager');
        stopStoreBot(storeId);
        db.deleteStore(storeId);
        return sendJson({ ok: true, deleted: storeId });
      }

      return sendJson({ ok: false, error: 'API endpoint not found' }, 404);
    }

    sendJson({ error: 'Not found' }, 404);
  });

  return server;
}

module.exports = { createServer };
