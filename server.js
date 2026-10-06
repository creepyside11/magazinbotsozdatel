const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { createCryptoBotInvoice, createXRocketInvoice } = require('./crypto');

function createHttpServer(bot, adminId) {
  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    // CORS & JSON helpers
    const sendJson = (data, status = 200) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end(JSON.stringify(data));
    };

    // Parse JSON body helper
    const readBody = () => new Promise((resolve) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); }
        catch (e) { resolve({}); }
      });
    });

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }

    // Static file serving from /public
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.svg': 'image/svg+xml'
        };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      res.writeHead(404);
      return res.end('Not found');
    }

    // API Routes
    if (pathname === '/api/user' && req.method === 'GET') {
      const id = parseInt(urlObj.searchParams.get('id'));
      const username = urlObj.searchParams.get('username') || '';
      const first_name = urlObj.searchParams.get('first_name') || '';
      if (!id) return sendJson({ ok: false, error: 'User ID required' }, 400);

      const user = db.getUser(id, username, first_name);
      const support = db.getSetting('support_contact') || '@admin';
      const storeName = db.getSetting('store_name') || 'TERMINAL STORE';
      const privacyUrl = db.getSetting('privacy_policy_url') || '';
      const termsUrl = db.getSetting('terms_of_service_url') || '';
      const refEnabled = db.getSetting('ref_system_enabled') === '1';
      const refPercent = db.getSetting('ref_reward_percent') || '10';
      const reviewsEnabled = db.getSetting('reviews_enabled') !== '0';
      const referrals = db.getReferrals(id);

      return sendJson({
        ok: true,
        user,
        support_contact: support,
        store_name: storeName,
        privacy_policy_url: privacyUrl,
        terms_of_service_url: termsUrl,
        reviews_enabled: reviewsEnabled,
        ref_system: {
          enabled: refEnabled,
          percent: refPercent,
          referralsCount: referrals.length
        }
      });
    }

    if (pathname === '/api/categories' && req.method === 'GET') {
      const categories = db.getCategories();
      return sendJson({ ok: true, categories });
    }

    if (pathname === '/api/products' && req.method === 'GET') {
      const categoryId = urlObj.searchParams.get('categoryId');
      const products = db.getProducts(categoryId ? parseInt(categoryId) : null);
      
      const prodsWithRating = products.map(p => {
        const rating = db.getProductRating(p.id);
        return { ...p, rating };
      });

      return sendJson({ ok: true, products: prodsWithRating });
    }

    if (pathname === '/api/product/reviews' && req.method === 'GET') {
      const reviewsEnabled = db.getSetting('reviews_enabled') !== '0';
      if (!reviewsEnabled) {
        return sendJson({ ok: true, reviews: [], rating: { average: 0, count: 0 }, canReview: false, reviews_enabled: false });
      }
      const productId = parseInt(urlObj.searchParams.get('productId'));
      const userId = parseInt(urlObj.searchParams.get('userId'));
      if (!productId) return sendJson({ ok: false, error: 'Product ID required' }, 400);
      const reviews = db.getProductReviews(productId);
      const rating = db.getProductRating(productId);
      const canReview = userId ? db.hasUserPurchasedProduct(userId, productId) : false;
      return sendJson({ ok: true, reviews, rating, canReview, reviews_enabled: true });
    }

    if (pathname === '/api/product/review' && req.method === 'POST') {
      const reviewsEnabled = db.getSetting('reviews_enabled') !== '0';
      if (!reviewsEnabled) {
        return sendJson({ ok: false, error: 'Система отзывов временно отключена администратором' }, 403);
      }
      const body = await readBody();
      const { productId, userId, userName, rating, comment } = body;
      if (!productId || !userId || !rating) return sendJson({ ok: false, error: 'Missing params' }, 400);

      const hasPurchased = db.hasUserPurchasedProduct(userId, productId);
      if (!hasPurchased) {
        return sendJson({ ok: false, error: 'Для оставления отзыва необходимо сначала купить этот товар' }, 403);
      }

      db.addReview(productId, userId, userName || 'Покупатель', rating, comment || '');
      return sendJson({ ok: true });
    }

    if (pathname === '/api/promo/activate' && req.method === 'POST') {
      const body = await readBody();
      const { userId, code } = body;
      if (!userId || !code) return sendJson({ ok: false, error: 'Введите промокод' }, 400);
      const resPromo = db.activatePromoCode(userId, code);
      return sendJson(resPromo);
    }

    if (pathname === '/api/orders' && req.method === 'GET') {
      const userId = parseInt(urlObj.searchParams.get('userId'));
      if (!userId) return sendJson({ ok: false, error: 'User ID required' }, 400);
      const orders = db.getUserPurchases(userId);
      return sendJson({ ok: true, orders });
    }

    if (pathname === '/api/purchase' && req.method === 'POST') {
      const body = await readBody();
      const { userId, productId } = body;
      if (!userId || !productId) return sendJson({ ok: false, error: 'Missing parameters' }, 400);

      const user = db.getUser(userId);
      const prod = db.getProduct(productId);
      if (!prod) return sendJson({ ok: false, error: 'Товар не найден' }, 404);

      let pool = [];
      try { pool = JSON.parse(prod.content_pool || '[]'); } catch(e) {}
      if (pool.length === 0) {
        return sendJson({ ok: false, error: 'Товара нет в наличии' }, 400);
      }

      if (user.balance < prod.price) {
        return sendJson({ ok: false, error: 'Недостаточно средств на балансе' }, 400);
      }

      // Deduct balance and pick item
      const itemContent = pool.shift();
      db.updateUserBalance(userId, -prod.price);
      db.updateProductPool(productId, pool);
      db.addPurchase(userId, productId, prod.title, prod.price, itemContent);

      // Check stock alert for admin
      if (pool.length <= 2) {
        bot.telegram.sendMessage(
          adminId,
          `⚠️ <b>Внимание: товар заканчивается!</b>\n\n` +
          `Товар: <b>${prod.title}</b>\n` +
          `Остаток на складе: <b>${pool.length} шт.</b>\n` +
          `Пополните пул ключей через админ-панель.`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }

      // Notify Telegram user in chat
      try {
        await bot.telegram.sendMessage(
          userId,
          `📦 <b>Успешная покупка!</b>\n\n` +
          `🏷 <b>Товар:</b> ${prod.title}\n` +
          `💰 <b>Сумма:</b> ${prod.price} ₽\n\n` +
          `🔑 <b>Ваш товар / ключ:</b>\n<code>${itemContent}</code>\n\n` +
          `<i>Спасибо за покупку! Данные также сохранены во вкладке «Мои покупки».</i>`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        console.error('Failed to send notification via bot:', err.message);
      }

      return sendJson({ ok: true, delivered: itemContent });
    }

    if (pathname === '/api/deposit/create' && req.method === 'POST') {
      const body = await readBody();
      const { userId, amount, method } = body;
      if (!userId || !amount || !method) return sendJson({ ok: false, error: 'Неверные параметры' }, 400);

      if (method === 'card' || method === 'sbp') {
        const deposit = db.createDeposit(userId, amount, method);
        const reqs = method === 'card' ? db.getSetting('card_requisites') : db.getSetting('sbp_requisites');

        // Notify user in bot chat with instructions to pay & send screenshot
        try {
          await bot.telegram.sendMessage(
            userId,
            `💳 <b>Заявка на пополнение #${deposit.lastInsertRowid}</b>\n\n` +
            `Способ: <b>${method === 'card' ? 'Банковская карта' : 'СБП'}</b>\n` +
            `Сумма к оплате: <b>${amount} ₽</b>\n\n` +
            `Реквизиты для перевода:\n<code>${reqs}</code>\n\n` +
            `⚠️ <i>После перевода отправьте скриншот чека прямо в этот диалог с ботом!</i>`,
            { parse_mode: 'HTML' }
          );
        } catch (e) {
          console.error(e.message);
        }

        return sendJson({ ok: true, action: 'manual', depositId: deposit.lastInsertRowid });
      }

      if (method === 'cryptobot') {
        try {
          const inv = await createCryptoBotInvoice(amount);
          db.createDeposit(userId, amount, 'cryptobot', null, inv.invoiceId);
          return sendJson({ ok: true, action: 'crypto', payUrl: inv.payUrl });
        } catch (err) {
          return sendJson({ ok: false, error: err.message });
        }
      }

      if (method === 'xrocket') {
        try {
          const inv = await createXRocketInvoice(amount);
          db.createDeposit(userId, amount, 'xrocket', null, inv.invoiceId);
          return sendJson({ ok: true, action: 'crypto', payUrl: inv.payUrl });
        } catch (err) {
          return sendJson({ ok: false, error: err.message });
        }
      }

      return sendJson({ ok: false, error: 'Неизвестный способ оплаты' }, 400);
    }

    sendJson({ error: 'Endpoint not found' }, 404);
  });

  return server;
}

module.exports = { createHttpServer };
