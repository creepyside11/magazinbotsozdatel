const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
const crypto = require('crypto');

// Map of active Telegraf instances: storeId -> Telegraf instance
const activeBots = new Map();
const userStates = new Map(); // session state for dialogs

function getPublicMiniAppUrl(storeId, baseUrl) {
  return `https://bot-factory-miniapp.vercel.app/?shop=${storeId}`;
}

// Format crypto payment helpers
async function createCryptoInvoice(store, amountRub, method) {
  const rate = parseFloat(store.usdt_rate || '95');
  const amountUsdt = Math.max(0.1, +(amountRub / rate).toFixed(2));

  if (method === 'cryptobot') {
    const token = store.cryptobot_token;
    if (!token) throw new Error('CryptoBot токен не настроен владельцем магазина');
    const res = await fetch('https://pay.crypt.bot/api/createInvoice', {
      method: 'POST',
      headers: { 'Crypto-Pay-API-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset: 'USDT',
        amount: amountUsdt.toString(),
        description: `Пополнение баланса (${amountRub} RUB)`,
        expires_in: 3600
      })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error?.name || 'Ошибка создания счета CryptoBot');
    return {
      invoiceId: data.result.invoice_id,
      payUrl: data.result.bot_invoice_url || data.result.pay_url,
      amountUsdt
    };
  }

  if (method === 'xrocket') {
    const token = store.xrocket_token;
    if (!token) throw new Error('xRocket токен не настроен владельцем магазина');
    const res = await fetch('https://pay.xrocket.tg/tg-invoices', {
      method: 'POST',
      headers: { 'Rocket-Pay-Key': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amountUsdt,
        currency: 'USDT',
        description: `Пополнение баланса (${amountRub} RUB)`,
        numPayments: 1
      })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.message || 'Ошибка создания счета xRocket');
    return {
      invoiceId: data.data.id,
      payUrl: data.data.link,
      amountUsdt
    };
  }

  throw new Error('Неизвестный метод');
}

// Initialize and start a store bot
async function startStoreBot(store, getBaseUrl) {
  if (activeBots.has(store.id)) {
    try {
      activeBots.get(store.id).stop();
    } catch(e) {}
    activeBots.delete(store.id);
  }

  const bot = new Telegraf(store.bot_token);

  bot.catch((err, ctx) => {
    console.error(`[StoreBot ${store.id} Error]:`, err.message);
  });

  const getMenuKeyboard = (userId) => {
    const baseUrl = getBaseUrl();
    const appUrl = getPublicMiniAppUrl(store.id, baseUrl);
    const buttons = [
      [{ text: '⚡ Открыть магазин (Mini App)', web_app: { url: appUrl } }],
      [
        { text: '🛍 Каталог товаров', callback_data: 'catalog' },
        { text: '👤 Мой профиль', callback_data: 'profile' }
      ],
      [
        { text: '💳 Пополнить баланс', callback_data: 'deposit' },
        { text: '📦 Мои покупки', callback_data: 'purchases' }
      ]
    ];
    if (store.support_contact) {
      buttons.push([{ text: '💬 Поддержка', callback_data: 'support' }]);
    }
    if (userId === store.admin_id) {
      buttons.push([{ text: '⚙️ Панель управления (Admin)', callback_data: 'admin_panel' }]);
    }
    return Markup.inlineKeyboard(buttons);
  };

  bot.start(async (ctx) => {
    try {
      const user = db.getStoreUser(store.id, ctx.from.id, ctx.from.username, ctx.from.first_name);
      const text =
        `🛍 <b>${store.store_name}</b>\n\n` +
        `Приветствуем, <b>${ctx.from.first_name || 'клиент'}</b>!\n` +
        `Автоматический магазин цифровых товаров.\n\n` +
        `🆔 Ваш ID: <code>${user.id}</code>\n` +
        `💰 Баланс: <b>${user.balance.toFixed(2)} ₽</b>\n\n` +
        `Выберите действие в меню или откройте Web App:`;
      await ctx.reply(text, { parse_mode: 'HTML', ...getMenuKeyboard(ctx.from.id) });
    } catch(err) {
      console.error(`[StoreBot start error]:`, err.message);
    }
  });

  bot.action('profile', async (ctx) => {
    await ctx.answerCbQuery();
    const user = db.getStoreUser(store.id, ctx.from.id);
    const purchases = db.getUserPurchases(store.id, ctx.from.id);
    const text =
      `👤 <b>Личный кабинет</b>\n\n` +
      `• ID: <code>${user.id}</code>\n` +
      `• Баланс: <b>${user.balance.toFixed(2)} ₽</b>\n` +
      `• Покупок: <b>${purchases.length} шт.</b>`;
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💳 Пополнить баланс', 'deposit')],
        [Markup.button.callback('📦 Мои покупки', 'purchases')],
        [Markup.button.callback('◀️ Назад', 'back_main')]
      ])
    });
  });

  bot.action('purchases', async (ctx) => {
    await ctx.answerCbQuery();
    const orders = db.getUserPurchases(store.id, ctx.from.id);
    if (orders.length === 0) {
      return ctx.reply('📦 У вас пока нет оформленных заказов.');
    }
    let text = `📦 <b>Ваши покупки (всего: ${orders.length}):</b>\n\n`;
    orders.slice(0, 5).forEach((o, idx) => {
      text += `<b>${idx + 1}. ${o.product_title}</b> — ${o.price} ₽\n📅 ${o.created_at}\n🔑 <code>${o.delivered_content}</code>\n\n`;
    });
    const buttons = [];
    const revEnabled = store.reviews_enabled !== 0;
    orders.slice(0, 5).forEach((o, idx) => {
      buttons.push([{ text: `📋 Скопировать #${idx + 1}`, copy_text: { text: o.delivered_content } }]);
      if (revEnabled) {
        buttons.push([{ text: `⭐️ Оставить отзыв о товаре #${idx + 1}`, callback_data: `rev_${o.product_id}` }]);
      }
    });
    buttons.push([{ text: '◀️ В меню', callback_data: 'back_main' }]);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  });

  bot.action('catalog', async (ctx) => {
    await ctx.answerCbQuery();
    const cats = db.getCategories(store.id);
    if (cats.length === 0) {
      return ctx.reply('🛍 Каталог пока пуст.');
    }
    const buttons = cats.map(c => [Markup.button.callback(c.title, `cat_${c.id}`)]);
    buttons.push([Markup.button.callback('◀️ Назад', 'back_main')]);
    await ctx.reply('📂 <b>Выберите категорию:</b>', { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  });

  bot.action(/^cat_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const catId = parseInt(ctx.match[1]);
    const prods = db.getProducts(store.id, catId);
    if (prods.length === 0) {
      return ctx.reply('В этой категории пока нет товаров.');
    }
    const buttons = prods.map(p => {
      let stock = 0;
      try { stock = JSON.parse(p.content_pool || '[]').length; } catch(e) {}
      return [Markup.button.callback(`${p.title} — ${p.price} ₽ (${stock} шт.)`, `prod_${p.id}`)];
    });
    buttons.push([Markup.button.callback('◀️ К категориям', 'catalog')]);
    await ctx.reply('🛍 <b>Товары:</b>', { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  });

  bot.action(/^prod_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const prodId = parseInt(ctx.match[1]);
    const p = db.getProduct(store.id, prodId);
    if (!p) return ctx.reply('Товар не найден.');

    let stock = 0;
    try { stock = JSON.parse(p.content_pool || '[]').length; } catch(e) {}
    const revEnabled = store.reviews_enabled !== 0;
    const ratingData = db.getProductRating(store.id, prodId);
    const ratingStr = ratingData.count > 0 ? `★ ${ratingData.average} (${ratingData.count} отзывов)` : 'Отзывов пока нет';

    let text = `🏷 <b>${p.title}</b>\n\n📝 ${p.description || 'Описание отсутствует.'}\n\n`;
    if (revEnabled) text += `⭐ <b>Рейтинг:</b> ${ratingStr}\n`;
    text += `💰 <b>Цена:</b> ${p.price} ₽\n📦 <b>В наличии:</b> ${stock} шт.`;

    const buttons = [];
    if (stock > 0) {
      buttons.push([Markup.button.callback('🛒 Купить за баланс', `buy_${p.id}`)]);
    } else {
      buttons.push([Markup.button.callback('❌ Нет в наличии', 'noop')]);
    }
    if (revEnabled && db.hasUserPurchasedProduct(store.id, ctx.from.id, p.id)) {
      buttons.push([Markup.button.callback('⭐️ Оставить отзыв', `rev_${p.id}`)]);
    }
    buttons.push([Markup.button.callback('◀️ Назад', 'catalog')]);
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  });

  bot.action(/^buy_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const prodId = parseInt(ctx.match[1]);
    const p = db.getProduct(store.id, prodId);
    const user = db.getStoreUser(store.id, ctx.from.id);
    if (!p) return ctx.reply('Товар не найден.');

    let pool = [];
    try { pool = JSON.parse(p.content_pool || '[]'); } catch(e) {}
    if (pool.length === 0) return ctx.reply('❌ К сожалению, товар закончился.');

    if (user.balance < p.price) {
      return ctx.reply(
        `❌ <b>Недостаточно средств!</b>\nЦена: ${p.price} ₽\nВаш баланс: ${user.balance.toFixed(2)} ₽`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('💳 Пополнить баланс', 'deposit')]]) }
      );
    }

    const delivered = pool.shift();
    db.updateStoreUserBalance(store.id, ctx.from.id, -p.price);
    db.updateProductPool(store.id, prodId, pool);
    db.addPurchase(store.id, ctx.from.id, prodId, p.title, p.price, delivered);

    const bBtns = [];
    if (store.reviews_enabled !== 0) {
      bBtns.push([Markup.button.callback('⭐️ Оставить отзыв о товаре', `rev_${prodId}`)]);
    }
    bBtns.push([Markup.button.callback('◀️ В меню', 'back_main')]);

    await ctx.reply(
      `✅ <b>Покупка совершена!</b>\n\n🏷 <b>Товар:</b> ${p.title}\n💰 <b>Списано:</b> ${p.price} ₽\n\n🔑 <b>Ваш товар:</b>\n<code>${delivered}</code>`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard(bBtns) }
    );
  });

  // Reviews flow in bot
  bot.action(/^rev_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (store.reviews_enabled === 0) {
      return ctx.reply('❌ Система отзывов отключена администратором.');
    }
    const prodId = parseInt(ctx.match[1]);
    const hasBought = db.hasUserPurchasedProduct(store.id, ctx.from.id, prodId);
    if (!hasBought) {
      return ctx.reply('❌ Для оставления отзыва необходимо сначала купить этот товар.');
    }
    const p = db.getProduct(store.id, prodId);
    userStates.set(`${store.id}_${ctx.from.id}`, { step: 'rev_rating', prodId });
    const stars = [1, 2, 3, 4, 5].map(s => Markup.button.callback(`⭐️ ${s}`, `setrev_${prodId}_${s}`));
    await ctx.reply(`⭐ <b>Оценка товара «${p?.title || ''}»</b>\nВыберите рейтинг:`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([stars, [Markup.button.callback('❌ Отмена', 'back_main')]])
    });
  });

  bot.action(/^setrev_(\d+)_([1-5])$/, async (ctx) => {
    await ctx.answerCbQuery();
    const prodId = parseInt(ctx.match[1]);
    const rating = parseInt(ctx.match[2]);
    userStates.set(`${store.id}_${ctx.from.id}`, { step: 'rev_comment', prodId, rating });
    await ctx.reply(`⭐ Вы выбрали: <b>${rating}/5</b>\n\nНапишите ваш комментарий в ответном сообщении (или отправьте "-", если без текста):`, {
      parse_mode: 'HTML'
    });
  });

  // Admin panel action
  bot.action('admin_panel', async (ctx) => {
    if (ctx.from.id !== store.admin_id) return ctx.answerCbQuery('Доступ запрещен');
    await ctx.answerCbQuery();
    const stats = db.getStoreStats(store.id);

    const text =
      `⚙️ <b>Панель управления магазином: ${store.store_name}</b>\n\n` +
      `📊 <b>Статистика:</b>\n` +
      `• Покупателей: <b>${stats.users}</b>\n` +
      `• Товаров: <b>${stats.productsCount}</b>\n` +
      `• Заказов: <b>${stats.ordersCount}</b> (на <b>${stats.ordersVolume} ₽</b>)\n` +
      `• Одобрено пополнений: <b>${stats.depositsCount}</b> (на <b>${stats.depositsVolume} ₽</b>)\n\n` +
      `Выберите раздел для настройки:`;

    const buttons = [
      [
        Markup.button.callback('📂 Категории', 'adm_categories'),
        Markup.button.callback('🏷 Добавить товар', 'adm_add_product')
      ],
      [
        Markup.button.callback('💳 Реквизиты оплаты', 'adm_requisites'),
        Markup.button.callback('⭐️ Отзывы', 'adm_toggle_reviews')
      ],
      [
        Markup.button.callback('🤖 Токены CryptoBot / xRocket', 'adm_tokens'),
        Markup.button.callback('◀️ В главное меню', 'back_main')
      ]
    ];

    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  });

  bot.action('adm_categories', async (ctx) => {
    if (ctx.from.id !== store.admin_id) return;
    await ctx.answerCbQuery();
    const cats = db.getCategories(store.id);
    let text = `📂 <b>Категории магазина:</b>\n\n`;
    if (cats.length === 0) text += `Категорий пока нет.\n`;
    cats.forEach((c, i) => { text += `${i + 1}. <b>${c.title}</b>\n`; });

    const buttons = [
      [Markup.button.callback('➕ Добавить категорию', 'adm_add_cat')],
      [Markup.button.callback('◀️ Назад в админку', 'admin_panel')]
    ];
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  });

  bot.action('adm_add_cat', async (ctx) => {
    if (ctx.from.id !== store.admin_id) return;
    await ctx.answerCbQuery();
    userStates.set(`${store.id}_${ctx.from.id}`, { step: 'adm_cat_title' });
    await ctx.reply('Введите название новой категории:');
  });

  bot.action('adm_add_product', async (ctx) => {
    if (ctx.from.id !== store.admin_id) return;
    await ctx.answerCbQuery();
    const cats = db.getCategories(store.id);
    if (cats.length === 0) {
      return ctx.reply('Сначала создайте хотя бы одну категорию!', Markup.inlineKeyboard([
        [Markup.button.callback('➕ Добавить категорию', 'adm_add_cat')],
        [Markup.button.callback('◀️ Назад', 'admin_panel')]
      ]));
    }
    userStates.set(`${store.id}_${ctx.from.id}`, { step: 'adm_prod_title', catId: cats[0].id });
    await ctx.reply('Введите <b>название товара</b>:', { parse_mode: 'HTML' });
  });

  bot.action('adm_requisites', async (ctx) => {
    if (ctx.from.id !== store.admin_id) return;
    await ctx.answerCbQuery();
    const text =
      `💳 <b>Реквизиты для оплаты</b>\n\n` +
      `• Карта: <code>${store.card_requisites || 'не указана'}</code>\n` +
      `• СБП: <code>${store.sbp_requisites || 'не указан'}</code>`;
    const buttons = [
      [Markup.button.callback('✏️ Изменить карту', 'adm_set_card')],
      [Markup.button.callback('✏️ Изменить СБП', 'adm_set_sbp')],
      [Markup.button.callback('◀️ Назад', 'admin_panel')]
    ];
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  });

  bot.action('adm_set_card', async (ctx) => {
    if (ctx.from.id !== store.admin_id) return;
    await ctx.answerCbQuery();
    userStates.set(`${store.id}_${ctx.from.id}`, { step: 'adm_set_card' });
    await ctx.reply('Введите номер карты и банк получателя:');
  });

  bot.action('adm_set_sbp', async (ctx) => {
    if (ctx.from.id !== store.admin_id) return;
    await ctx.answerCbQuery();
    userStates.set(`${store.id}_${ctx.from.id}`, { step: 'adm_set_sbp' });
    await ctx.reply('Введите номер телефона и банк СБП:');
  });

  bot.action('adm_toggle_reviews', async (ctx) => {
    if (ctx.from.id !== store.admin_id) return;
    await ctx.answerCbQuery();
    const curr = store.reviews_enabled !== 0;
    store.reviews_enabled = curr ? 0 : 1;
    db.updateStoreSetting(store.id, 'reviews_enabled', store.reviews_enabled);
    await ctx.reply(store.reviews_enabled ? '✅ Система отзывов включена.' : '❌ Система отзывов отключена.', Markup.inlineKeyboard([
      [Markup.button.callback('◀️ Назад', 'admin_panel')]
    ]));
  });

  bot.action('adm_tokens', async (ctx) => {
    if (ctx.from.id !== store.admin_id) return;
    await ctx.answerCbQuery();
    const buttons = [
      [Markup.button.callback('🤖 Токен CryptoBot', 'adm_set_cryptobot')],
      [Markup.button.callback('🚀 Токен xRocket', 'adm_set_xrocket')],
      [Markup.button.callback('◀️ Назад', 'admin_panel')]
    ];
    await ctx.reply('🔑 <b>Настройка криптовалютных шлюзов:</b>', { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  });

  bot.action('adm_set_cryptobot', async (ctx) => {
    if (ctx.from.id !== store.admin_id) return;
    await ctx.answerCbQuery();
    userStates.set(`${store.id}_${ctx.from.id}`, { step: 'adm_set_cryptobot' });
    await ctx.reply('Введите API токен CryptoBot (от @CryptoBot -> Crypto Pay):');
  });

  bot.action('adm_set_xrocket', async (ctx) => {
    if (ctx.from.id !== store.admin_id) return;
    await ctx.answerCbQuery();
    userStates.set(`${store.id}_${ctx.from.id}`, { step: 'adm_set_xrocket' });
    await ctx.reply('Введите API ключ xRocket (от @xrocket -> Pay):');
  });

  // Deposit menu
  bot.action('deposit', async (ctx) => {
    await ctx.answerCbQuery();
    const btns = [];
    if (store.card_requisites) btns.push([Markup.button.callback('💳 Банковская карта', 'dep_card')]);
    if (store.sbp_requisites) btns.push([Markup.button.callback('📱 СБП', 'dep_sbp')]);
    if (store.cryptobot_token) btns.push([Markup.button.callback('🤖 Crypto Bot (USDT)', 'dep_cryptobot')]);
    if (store.xrocket_token) btns.push([Markup.button.callback('🚀 xRocket (USDT)', 'dep_xrocket')]);
    btns.push([Markup.button.callback('◀️ Назад', 'back_main')]);

    await ctx.reply('💳 <b>Выберите способ пополнения баланса:</b>', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(btns)
    });
  });

  bot.action(/^dep_(card|sbp|cryptobot|xrocket)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const method = ctx.match[1];
    userStates.set(`${store.id}_${ctx.from.id}`, { step: 'dep_amount', method });
    await ctx.reply('💰 Введите сумму пополнения в рублях (минимум 10 ₽):');
  });

  bot.action('back_main', async (ctx) => {
    await ctx.answerCbQuery();
    userStates.delete(`${store.id}_${ctx.from.id}`);
    await ctx.reply('📋 Главное меню:', getMenuKeyboard(ctx.from.id));
  });

  // Text message handler for store bots
  bot.on('text', async (ctx) => {
    const stKey = `${store.id}_${ctx.from.id}`;
    const st = userStates.get(stKey);
    if (!st) return;

    if (st.step === 'adm_cat_title') {
      userStates.delete(stKey);
      db.addCategory(store.id, ctx.message.text.trim());
      return ctx.reply(`✅ Категория «${ctx.message.text.trim()}» создана!`, Markup.inlineKeyboard([
        [Markup.button.callback('📂 К категориям', 'adm_categories')],
        [Markup.button.callback('◀️ В админку', 'admin_panel')]
      ]));
    }

    if (st.step === 'adm_prod_title') {
      st.title = ctx.message.text.trim();
      st.step = 'adm_prod_price';
      return ctx.reply('Введите <b>цену товара в рублях</b> (число):', { parse_mode: 'HTML' });
    }

    if (st.step === 'adm_prod_price') {
      const price = parseFloat(ctx.message.text.trim());
      if (isNaN(price) || price < 0) return ctx.reply('Введите число:');
      st.price = price;
      st.step = 'adm_prod_keys';
      return ctx.reply('Отправьте <b>ключи/товары</b> (каждый с новой строки) или 0:');
    }

    if (st.step === 'adm_prod_keys') {
      const pool = ctx.message.text.trim() === '0' ? [] : ctx.message.text.trim().split('\n').map(s => s.trim()).filter(Boolean);
      userStates.delete(stKey);
      db.addProduct(store.id, st.catId, st.title, '', st.price, pool);
      return ctx.reply(`✅ Товар «${st.title}» (${st.price} ₽, ${pool.length} шт.) успешно добавлен!`, Markup.inlineKeyboard([
        [Markup.button.callback('🏷 Добавить еще', 'adm_add_product')],
        [Markup.button.callback('◀️ В админку', 'admin_panel')]
      ]));
    }

    if (st.step === 'adm_set_card') {
      userStates.delete(stKey);
      store.card_requisites = ctx.message.text.trim();
      db.updateStoreSetting(store.id, 'card_requisites', store.card_requisites);
      return ctx.reply('✅ Реквизиты карты обновлены!', Markup.inlineKeyboard([
        [Markup.button.callback('◀️ В админку', 'admin_panel')]
      ]));
    }

    if (st.step === 'adm_set_sbp') {
      userStates.delete(stKey);
      store.sbp_requisites = ctx.message.text.trim();
      db.updateStoreSetting(store.id, 'sbp_requisites', store.sbp_requisites);
      return ctx.reply('✅ Реквизиты СБП обновлены!', Markup.inlineKeyboard([
        [Markup.button.callback('◀️ В админку', 'admin_panel')]
      ]));
    }

    if (st.step === 'adm_set_cryptobot') {
      userStates.delete(stKey);
      store.cryptobot_token = ctx.message.text.trim();
      db.updateStoreSetting(store.id, 'cryptobot_token', store.cryptobot_token);
      return ctx.reply('✅ Токен CryptoBot сохранён!', Markup.inlineKeyboard([
        [Markup.button.callback('◀️ В админку', 'admin_panel')]
      ]));
    }

    if (st.step === 'adm_set_xrocket') {
      userStates.delete(stKey);
      store.xrocket_token = ctx.message.text.trim();
      db.updateStoreSetting(store.id, 'xrocket_token', store.xrocket_token);
      return ctx.reply('✅ Токен xRocket сохранён!', Markup.inlineKeyboard([
        [Markup.button.callback('◀️ В админку', 'admin_panel')]
      ]));
    }

    if (st.step === 'rev_comment') {
      const { prodId, rating } = st;
      userStates.delete(stKey);
      const comment = ctx.message.text === '-' ? '' : ctx.message.text;
      const userName = ctx.from.first_name || 'Покупатель';
      db.addReview(store.id, prodId, ctx.from.id, userName, rating, comment);
      return ctx.reply('⭐️ <b>Спасибо за отзыв!</b> Ваша оценка сохранена.', { parse_mode: 'HTML' });
    }

    if (st.step === 'dep_amount') {
      const amount = parseFloat(ctx.message.text);
      if (isNaN(amount) || amount < 10) return ctx.reply('Введите корректную сумму (минимум 10 ₽):');
      const method = st.method;
      userStates.delete(stKey);

      if (method === 'card' || method === 'sbp') {
        const dep = db.createDeposit(store.id, ctx.from.id, amount, method);
        const reqs = method === 'card' ? store.card_requisites : store.sbp_requisites;
        return ctx.reply(
          `💳 <b>Заявка на пополнение #${dep.lastInsertRowid}</b>\n\nСумма: <b>${amount} ₽</b>\nРеквизиты для оплаты:\n<code>${reqs}</code>\n\n<i>Отправьте чек об оплате администратору для подтверждения.</i>`,
          { parse_mode: 'HTML' }
        );
      }

      if (method === 'cryptobot' || method === 'xrocket') {
        try {
          const inv = await createCryptoInvoice(store, amount, method);
          db.createDeposit(store.id, ctx.from.id, amount, method, null, inv.invoiceId);
          return ctx.reply(
            `💸 <b>Счёт на оплату создан!</b>\nСумма: <b>${amount} ₽</b> (≈ ${inv.amountUsdt} USDT)\n\nНажмите для оплаты:`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([[Markup.button.url('Оплатить счет', inv.payUrl)]])
            }
          );
        } catch (e) {
          return ctx.reply(`❌ Ошибка создания счета: ${e.message}`);
        }
      }
    }
  });

  try {
    bot.launch({ dropPendingUpdates: true }).catch(err => {
      console.error(`[StoreBot LongPolling Error @${store.bot_username || store.id}]:`, err.message);
    });
    activeBots.set(store.id, bot);
    console.log(`[StoreBot] @${store.bot_username || store.id} successfully started.`);
    return true;
  } catch (err) {
    console.error(`[StoreBot] Failed to start @${store.bot_username || store.id}:`, err.message);
    return false;
  }
}

function stopStoreBot(storeId) {
  if (activeBots.has(storeId)) {
    try {
      activeBots.get(storeId).stop();
    } catch(e) {}
    activeBots.delete(storeId);
    console.log(`[StoreBot] ${storeId} stopped.`);
  }
}

module.exports = {
  startStoreBot,
  stopStoreBot,
  activeBots,
  getPublicMiniAppUrl
};
