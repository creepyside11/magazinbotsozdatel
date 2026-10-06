const { readFileSync, existsSync } = require('fs');
const { join } = require('path');

// Memory in-memory and file store for demo & persistence
let storeData = {
  users: {},
  purchases: [],
  reviews: [],
  categories: [
    { id: 1, title: 'Цифровые подписки' },
    { id: 2, title: 'Black russia' }
  ],
  products: [
    {
      id: 3,
      category_id: 2,
      title: 'акк 5 лвл',
      description: '🔥 Быстрая выдача ключа\nАвтоматическая доставка 24/7',
      price: 400,
      image_url: null,
      content_pool: ['КЛЮЧ_АКК_5_LVL']
    },
    {
      id: 2,
      category_id: 2,
      title: 'Вирты',
      description: 'Игровая валюта Black Russia',
      price: 55,
      image_url: null,
      content_pool: ['ВИРТЫ_100К']
    },
    {
      id: 1,
      category_id: 1,
      title: 'Telegram Premium (1 месяц)',
      description: 'Активация подписки по ссылке-подарку',
      price: 299,
      image_url: null,
      content_pool: ['https://t.me/giftcode/SAMPLE-TP-2']
    }
  ]
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;
  const q = req.query || {};

  // GET /api/user
  if (pathname === '/api/user') {
    const id = parseInt(q.id || '8282599467');
    if (!storeData.users[id]) {
      storeData.users[id] = {
        id,
        username: q.username || '',
        first_name: q.first_name || 'Покупатель',
        balance: 1000
      };
    }
    const u = storeData.users[id];
    return res.json({
      ok: true,
      user: u,
      store_name: 'TERMINAL STORE',
      support_contact: '@EmeraldAiSupport',
      reviews_enabled: true
    });
  }

  // GET /api/categories
  if (pathname === '/api/categories') {
    return res.json({ ok: true, categories: storeData.categories });
  }

  // GET /api/products
  if (pathname === '/api/products') {
    const catId = q.categoryId ? parseInt(q.categoryId) : null;
    let prods = storeData.products;
    if (catId) prods = prods.filter(p => p.category_id === catId);

    const mapped = prods.map(p => {
      const pReviews = storeData.reviews.filter(r => r.product_id === p.id);
      const avg = pReviews.length > 0 ? +(pReviews.reduce((s, r) => s + r.rating, 0) / pReviews.length).toFixed(1) : 5.0;
      return {
        ...p,
        rating: { average: avg, count: pReviews.length }
      };
    });
    return res.json({ ok: true, products: mapped });
  }

  // GET /api/product/reviews
  if (pathname === '/api/product/reviews') {
    const prodId = parseInt(q.productId || '0');
    const userId = parseInt(q.userId || '0');
    const pReviews = storeData.reviews.filter(r => r.product_id === prodId);
    const avg = pReviews.length > 0 ? +(pReviews.reduce((s, r) => s + r.rating, 0) / pReviews.length).toFixed(1) : 5.0;
    const canReview = storeData.purchases.some(p => p.user_id === userId && p.product_id === prodId);
    return res.json({
      ok: true,
      reviews: pReviews,
      rating: { average: avg, count: pReviews.length },
      canReview,
      reviews_enabled: true
    });
  }

  // POST /api/product/review
  if (pathname === '/api/product/review' && req.method === 'POST') {
    const { productId, userId, userName, rating, comment } = req.body || {};
    storeData.reviews.unshift({
      id: Date.now(),
      product_id: productId,
      user_id: userId,
      user_name: userName || 'Покупатель',
      rating,
      comment: comment || ''
    });
    return res.json({ ok: true });
  }

  // POST /api/purchase
  if (pathname === '/api/purchase' && req.method === 'POST') {
    const { userId, productId } = req.body || {};
    const u = storeData.users[userId];
    const p = storeData.products.find(x => x.id === productId);
    if (!p) return res.status(404).json({ ok: false, error: 'Товар не найден' });
    if (!u || u.balance < p.price) return res.status(400).json({ ok: false, error: 'Недостаточно средств на балансе' });

    u.balance -= p.price;
    const delivered = p.content_pool[0] || 'DEMO-KEY-DELIVERED';
    storeData.purchases.unshift({
      id: Date.now(),
      user_id: userId,
      product_id: p.id,
      product_title: p.title,
      price: p.price,
      delivered_content: delivered,
      created_at: new Date().toISOString()
    });

    return res.json({ ok: true, delivered });
  }

  // GET /api/orders
  if (pathname === '/api/orders') {
    const userId = parseInt(q.userId || '0');
    const myOrders = storeData.purchases.filter(p => p.user_id === userId);
    return res.json({ ok: true, orders: myOrders });
  }

  // POST /api/promo/activate
  if (pathname === '/api/promo/activate' && req.method === 'POST') {
    const { userId, code } = req.body || {};
    if (storeData.users[userId]) storeData.users[userId].balance += 100;
    return res.json({ ok: true, reward: 100 });
  }

  res.status(404).json({ ok: false, error: 'Not found' });
}
