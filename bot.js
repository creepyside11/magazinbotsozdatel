const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
const { createCryptoBotInvoice, createXRocketInvoice } = require('./crypto');

const BOT_TOKEN = process.env.BOT_TOKEN || '8879846994:AAGA1AXpCRkubLelpdI9TIKOePSJ4FEYcT0';
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID, 10) : 8282599467;

const bot = new Telegraf(BOT_TOKEN);

bot.catch((err, ctx) => {
  console.error(`[Bot Error for update ${ctx.update.update_id}]:`, err);
  ctx.reply('⚠️ Произошла внутренняя ошибка. Попробуйте снова или обратитесь к администратору.').catch(() => {});
});

// User state tracker for step-by-step forms in Telegram
const userStates = new Map();

function isAdmin(ctx) {
  return ctx.from && ctx.from.id === ADMIN_ID;
}

// Main Menu Keyboard
function getMainKeyboard(userId) {
  const miniappUrl = db.getSetting('miniapp_url') || 'https://google.com';
  const refEnabled = db.getSetting('ref_system_enabled') === '1';

  const buttons = [
    [{ text: '⚡ Открыть магазин (Mini App)', web_app: { url: miniappUrl } }],
    [
      { text: '🛍 Каталог товаров', callback_data: 'user_catalog' },
      { text: '👤 Мой профиль', callback_data: 'user_profile' }
    ],
    [
      { text: '💳 Пополнить баланс', callback_data: 'user_deposit' },
      { text: '📦 Мои покупки', callback_data: 'user_purchases' }
    ]
  ];

  const middleRow = [];
  if (refEnabled) {
    middleRow.push({ text: '🤝 Партнёрка', callback_data: 'user_referral' });
  }
  middleRow.push({ text: '🎟 Промокод', callback_data: 'user_promo' });
  buttons.push(middleRow);

  buttons.push([{ text: '💬 Поддержка', callback_data: 'user_support' }]);

  if (userId === ADMIN_ID) {
    buttons.push([{ text: '⚙️ Панель управления (Admin)', callback_data: 'admin_main' }]);
  }

  return { reply_markup: { inline_keyboard: buttons } };
}

// /start with referral support
bot.start(async (ctx) => {
  const payload = ctx.message.text.split(' ')[1] || '';
  let refId = null;
  if (payload.startsWith('ref_')) {
    refId = parseInt(payload.replace('ref_', ''));
  }

  const user = db.getUser(ctx.from.id, ctx.from.username, ctx.from.first_name, refId);
  userStates.delete(ctx.from.id);
  const storeName = db.getSetting('store_name') || 'TERMINAL STORE';

  const text = 
    `🛍 <b>${storeName.toUpperCase()}</b>\n\n` +
    `Приветствуем, <b>${ctx.from.first_name || 'клиент'}</b>!\n` +
    `Автоматический магазин цифровых товаров, лицензий и подписок.\n\n` +
    `🆔 Ваш ID: <code>${user.id}</code>\n` +
    `💰 Баланс: <b>${user.balance.toFixed(2)} ₽</b>\n\n` +
    `Выберите действие в меню ниже или откройте Mini App:`;

  await ctx.reply(text, { parse_mode: 'HTML', ...getMainKeyboard(ctx.from.id) });
});

// /menu
bot.command('menu', async (ctx) => {
  await ctx.reply('📋 Главное меню:', getMainKeyboard(ctx.from.id));
});

// USER: Profile
bot.action('user_profile', async (ctx) => {
  await ctx.answerCbQuery();
  const user = db.getUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const purchases = db.getUserPurchases(ctx.from.id);

  const text = 
    `👤 <b>Личный кабинет</b>\n\n` +
    `• ID: <code>${user.id}</code>\n` +
    `• Имя: ${user.first_name || '—'}\n` +
    `• Username: ${user.username ? '@' + user.username : '—'}\n` +
    `• Баланс: <b>${user.balance.toFixed(2)} ₽</b>\n` +
    `• Покупок: <b>${purchases.length} шт.</b>\n` +
    `• Регистрация: ${user.created_at || '—'}`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💳 Пополнить баланс', 'user_deposit')],
    [Markup.button.callback('📦 Мои покупки', 'user_purchases')],
    [Markup.button.callback('◀️ В главное меню', 'back_to_main')]
  ]);

  await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
});

// USER: Referral Program
bot.action('user_referral', async (ctx) => {
  await ctx.answerCbQuery();
  const refEnabled = db.getSetting('ref_system_enabled') === '1';
  if (!refEnabled) return ctx.reply('Партнёрская программа временно приостановлена.');

  const percent = db.getSetting('ref_reward_percent') || '10';
  const referrals = db.getReferrals(ctx.from.id);
  const me = await ctx.telegram.getMe();
  const refLink = `https://t.me/${me.username}?start=ref_${ctx.from.id}`;

  const text = 
    `🤝 <b>Партнёрская программа</b>\n\n` +
    `Приглашайте друзей и знакомых в магазин и получайте <b>${percent}%</b> от каждого их пополнения баланса прямо на свой счёт!\n\n` +
    `• Приглашено друзей: <b>${referrals.length} чел.</b>\n` +
    `• Ваша ставка: <b>${percent}%</b>\n\n` +
    `Ваша персональная ссылка:\n<code>${refLink}</code>`;

  const keyboard = [
    [{ text: '📋 Скопировать ссылку', copy_text: { text: refLink } }],
    [{ text: '◀️ В главное меню', callback_data: 'back_to_main' }]
  ];

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
});

// USER: Promo Code
bot.action('user_promo', async (ctx) => {
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'awaiting_promo_input' });

  await ctx.reply(
    `🎟 <b>Активация промокода</b>\n\n` +
    `Введите код купона/промокода для мгновенного начисления средств на ваш баланс:`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'back_to_main' }]] }
    }
  );
});

bot.action('user_support', async (ctx) => {
  await ctx.answerCbQuery();
  const support = db.getSetting('support_contact') || '@admin';
  const text = 
    `💬 <b>Служба поддержки</b>\n\n` +
    `Если у вас возникли вопросы по оплате, получению товара или предложения о сотрудничестве, пожалуйста, обратитесь:\n\n` +
    `👨‍💻 <b>Контакт:</b> ${support}`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('◀️ Назад', 'back_to_main')]
  ]);
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
});

// USER: Purchases
bot.action('user_purchases', async (ctx) => {
  await ctx.answerCbQuery();
  const orders = db.getUserPurchases(ctx.from.id);

  if (orders.length === 0) {
    return ctx.editMessageText('📦 У вас пока нет оформленных заказов.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', 'back_to_main')]])
    });
  }

  let text = `📦 <b>Ваши покупки (всего: ${orders.length}):</b>\n\n`;

  orders.slice(0, 5).forEach((o, idx) => {
    text += `<b>${idx + 1}. ${o.product_title}</b> — ${o.price} ₽\n`;
    text += `📅 ${o.created_at}\n`;
    text += `🔑 <code>${o.delivered_content}</code>\n\n`;
  });

  const buttons = [];
  const reviewsEnabled = db.getSetting('reviews_enabled') !== '0';
  orders.slice(0, 5).forEach((o, idx) => {
    buttons.push([{ text: `📋 Скопировать товар #${idx + 1}`, copy_text: { text: o.delivered_content } }]);
    if (reviewsEnabled) {
      buttons.push([{ text: `⭐️ Оставить отзыв о товаре #${idx + 1}`, callback_data: `review_prod_${o.product_id}` }]);
    }
  });
  buttons.push([{ text: '◀️ В главное меню', callback_data: 'back_to_main' }]);

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  });
});

// USER: Catalog
bot.action('user_catalog', async (ctx) => {
  await ctx.answerCbQuery();
  const categories = db.getCategories();

  if (categories.length === 0) {
    return ctx.editMessageText('🛍 Каталог пока пуст. Администратор ещё не добавил категории.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', 'back_to_main')]])
    });
  }

  const buttons = categories.map(cat => [
    Markup.button.callback(cat.title, `cat_${cat.id}`)
  ]);
  buttons.push([Markup.button.callback('◀️ Назад', 'back_to_main')]);

  await ctx.editMessageText('📂 <b>Выберите категорию товаров:</b>', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  });
});

// Category products
bot.action(/^cat_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const catId = parseInt(ctx.match[1]);
  const prods = db.getProducts(catId);

  if (prods.length === 0) {
    return ctx.editMessageText('В данной категории нет товаров.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ К категориям', 'user_catalog')]])
    });
  }

  const buttons = prods.map(p => {
    let stock = 0;
    try { stock = JSON.parse(p.content_pool || '[]').length; } catch(e) {}
    return [Markup.button.callback(`${p.title} — ${p.price} ₽ (${stock} шт.)`, `prod_${p.id}`)];
  });
  buttons.push([Markup.button.callback('◀️ К категориям', 'user_catalog')]);

  await ctx.editMessageText('🛍 <b>Товары в категории:</b>', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  });
});

// View single product
bot.action(/^prod_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const prodId = parseInt(ctx.match[1]);
  const p = db.getProduct(prodId);

  if (!p) {
    return ctx.editMessageText('Товар не найден.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ К категориям', 'user_catalog')]])
    });
  }

  let stock = 0;
  try { stock = JSON.parse(p.content_pool || '[]').length; } catch(e) {}
  const reviewsEnabled = db.getSetting('reviews_enabled') !== '0';
  const ratingData = db.getProductRating(prodId);
  const ratingStr = ratingData.count > 0 ? `★ ${ratingData.average} (${ratingData.count} отзывов)` : 'Отзывов пока нет';

  let text =
    `🏷 <b>${p.title}</b>\n\n` +
    `📝 ${p.description || 'Описание отсутствует'}\n\n`;

  if (reviewsEnabled) {
    text += `⭐ <b>Рейтинг:</b> ${ratingStr}\n`;
  }

  text +=
    `💰 <b>Цена:</b> ${p.price} ₽\n` +
    `📦 <b>В наличии:</b> ${stock} шт.`;

  const buttons = [];
  if (stock > 0) {
    buttons.push([Markup.button.callback('🛒 Купить за баланс', `buy_prod_${p.id}`)]);
  } else {
    buttons.push([Markup.button.callback('❌ Нет в наличии', 'noop')]);
  }
  const hasBought = db.hasUserPurchasedProduct(ctx.from.id, p.id);
  if (hasBought && reviewsEnabled) {
    buttons.push([Markup.button.callback('⭐️ Оставить отзыв', `review_prod_${p.id}`)]);
  }
  buttons.push([Markup.button.callback('◀️ Назад к товарам', `cat_${p.category_id || 0}`)]);

  if (p.image_url) {
    try {
      await ctx.deleteMessage();
    } catch(e) {}
    try {
      const fs = require('fs');
      const path = require('path');
      let photoSource = p.image_url;
      if (p.image_url.startsWith('/uploads/')) {
        const localPath = path.join(__dirname, 'public', p.image_url);
        if (fs.existsSync(localPath)) {
          photoSource = { source: localPath };
        }
      }
      await ctx.replyWithPhoto(photoSource, {
        caption: text,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(buttons)
      });
    } catch (err) {
      console.error('Error replying with photo:', err);
      await ctx.reply(text, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(buttons)
      });
    }
  } else {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    });
  }
});

// Buy product
bot.action(/^buy_prod_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const prodId = parseInt(ctx.match[1]);
  const p = db.getProduct(prodId);
  const user = db.getUser(ctx.from.id);

  if (!p) return ctx.reply('Товар не найден.');

  let pool = [];
  try { pool = JSON.parse(p.content_pool || '[]'); } catch(e) {}
  if (pool.length === 0) {
    return ctx.reply('❌ К сожалению, товар закончился.');
  }

  if (user.balance < p.price) {
    return ctx.reply(
      `❌ <b>Недостаточно средств!</b>\n\n` +
      `Цена товара: ${p.price} ₽\n` +
      `Ваш баланс: ${user.balance.toFixed(2)} ₽\n\n` +
      `Пополните баланс для продолжения:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💳 Пополнить баланс', 'user_deposit')],
          [Markup.button.callback('◀️ Назад', 'user_catalog')]
        ])
      }
    );
  }

  // Process purchase
  const delivered = pool.shift();
  db.updateUserBalance(ctx.from.id, -p.price);
  db.updateProductPool(prodId, pool);
  db.addPurchase(ctx.from.id, prodId, p.title, p.price, delivered);

  const text =
    `✅ <b>Покупка успешно совершена!</b>\n\n` +
    `🏷 <b>Товар:</b> ${p.title}\n` +
    `💰 <b>Списано:</b> ${p.price} ₽\n\n` +
    `🔑 <b>Ваш товар / ключ:</b>\n<code>${delivered}</code>\n\n` +
    `<i>Вы всегда можете просмотреть свои товары в разделе «Мои покупки».</i>`;

  const buyButtons = [];
  const reviewsEnabled = db.getSetting('reviews_enabled') !== '0';
  if (reviewsEnabled) {
    buyButtons.push([Markup.button.callback('⭐️ Оставить отзыв о товаре', `review_prod_${prodId}`)]);
  }
  buyButtons.push([Markup.button.callback('◀️ В меню', 'back_to_main')]);

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buyButtons)
  });
});

// USER: Deposit Menu
bot.action('user_deposit', async (ctx) => {
  await ctx.answerCbQuery();
  const text = 
    `💳 <b>Пополнение баланса</b>\n\n` +
    `Выберите способ оплаты:\n\n` +
    `• <b>Банковская карта</b> — перевод по номеру карты\n` +
    `• <b>СБП</b> — мгновенный перевод по номеру телефона\n` +
    `• <b>Crypto Bot</b> — USDT, TON, BTC через Telegram\n` +
    `• <b>xRocket</b> — криптовалютный шлюз Telegram`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💳 Банковская карта', 'dep_method_card'), Markup.button.callback('📱 СБП', 'dep_method_sbp')],
    [Markup.button.callback('🤖 Crypto Bot', 'dep_method_cryptobot'), Markup.button.callback('🚀 xRocket', 'dep_method_xrocket')],
    [Markup.button.callback('◀️ В главное меню', 'back_to_main')]
  ]);

  await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
});

bot.action(/^dep_method_(card|sbp|cryptobot|xrocket)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const method = ctx.match[1];
  userStates.set(ctx.from.id, { step: 'awaiting_deposit_amount', method });

  await ctx.reply(
    `💰 <b>Введите сумму пополнения в рублях (₽):</b>\n(Минимум 10 ₽)`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'back_to_main')]]) }
  );
});

// Review product action
bot.action(/^review_prod_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const reviewsEnabled = db.getSetting('reviews_enabled') !== '0';
  if (!reviewsEnabled) {
    return ctx.reply('❌ Система отзывов временно отключена администратором.');
  }

  const prodId = parseInt(ctx.match[1]);
  const p = db.getProduct(prodId);
  if (!p) return ctx.reply('Товар не найден.');

  const hasBought = db.hasUserPurchasedProduct(ctx.from.id, prodId);
  if (!hasBought) {
    return ctx.reply('❌ Для оставления отзыва необходимо сначала купить этот товар.');
  }

  userStates.set(ctx.from.id, { step: 'awaiting_review_rating', productId: prodId, productTitle: p.title });

  const ratingButtons = [
    [
      Markup.button.callback('⭐️ 1', `set_rating_${prodId}_1`),
      Markup.button.callback('⭐️ 2', `set_rating_${prodId}_2`),
      Markup.button.callback('⭐️ 3', `set_rating_${prodId}_3`),
      Markup.button.callback('⭐️ 4', `set_rating_${prodId}_4`),
      Markup.button.callback('⭐️ 5', `set_rating_${prodId}_5`)
    ],
    [Markup.button.callback('❌ Отмена', 'back_to_main')]
  ];

  await ctx.reply(
    `⭐ <b>Оценка товара «${p.title}»</b>\n\nВыберите количество звезд от 1 до 5:`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(ratingButtons) }
  );
});

bot.action(/^set_rating_(\d+)_([1-5])$/, async (ctx) => {
  await ctx.answerCbQuery();
  const reviewsEnabled = db.getSetting('reviews_enabled') !== '0';
  if (!reviewsEnabled) {
    return ctx.reply('❌ Система отзывов временно отключена администратором.');
  }

  const prodId = parseInt(ctx.match[1]);
  const rating = parseInt(ctx.match[2]);
  const p = db.getProduct(prodId);

  const hasBought = db.hasUserPurchasedProduct(ctx.from.id, prodId);
  if (!hasBought) {
    return ctx.reply('❌ Для оставления отзыва необходимо сначала купить этот товар.');
  }

  userStates.set(ctx.from.id, { step: 'awaiting_review_comment', productId: prodId, rating, productTitle: p ? p.title : '' });

  await ctx.reply(
    `⭐ Вы выбрали оценку: <b>${rating}/5</b>\n\n` +
    `Напишите ваш текстовый отзыв в ответном сообщении (или отправьте "-", если хотите оставить без текста):`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'back_to_main')]])
    }
  );
});

// Back to main
bot.action('back_to_main', async (ctx) => {
  await ctx.answerCbQuery();
  userStates.delete(ctx.from.id);
  const user = db.getUser(ctx.from.id);
  const text = `📋 Главное меню:\n💰 Ваш баланс: <b>${user.balance.toFixed(2)} ₽</b>`;
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...getMainKeyboard(ctx.from.id) });
});

// ==========================================
// ADMIN PANEL
// ==========================================

bot.action('admin_main', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещен');
  await ctx.answerCbQuery();
  userStates.delete(ctx.from.id);

  const stats = db.getStats();
  const usdtRate = db.getSetting('usdt_rate') || '95';
  const storeName = db.getSetting('store_name') || 'TERMINAL STORE';

  const text = 
    `⚙️ <b>Панель управления: ${storeName}</b>\n\n` +
    `📊 <b>Общие показатели:</b>\n` +
    `• Пользователей: <b>${stats.users}</b>\n` +
    `• Товаров: <b>${stats.productsCount}</b>\n` +
    `• Чеков на проверке: <b>${stats.pendingDeposits}</b>\n` +
    `• Продано заказов: <b>${stats.ordersCount}</b> (на <b>${stats.ordersVolume.toFixed(2)} ₽</b>)\n` +
    `• Одобрено пополнений: <b>${stats.depositsCount}</b> (на <b>${stats.depositsVolume.toFixed(2)} ₽</b>)\n\n` +
    `📈 <b>За сегодня:</b>\n` +
    `• Заказов: <b>${stats.todayOrdersCount}</b> (на <b>${stats.todayOrdersVolume.toFixed(2)} ₽</b>)\n` +
    `• Пополнений: <b>${stats.todayDepositsVolume.toFixed(2)} ₽</b>\n\n` +
    `💵 Курс обмена: <b>1 USDT = ${usdtRate} ₽</b>`;

  const keyboard = [
    [
      { text: '👥 Пользователи', callback_data: 'admin_users_list' },
      { text: '📢 Рассылка', callback_data: 'admin_broadcast' }
    ],
    [
      { text: '📂 Категории', callback_data: 'admin_categories' },
      { text: '🏷 Товары', callback_data: 'admin_products' }
    ],
    [
      { text: '✏️ Название магазина', callback_data: 'admin_set_store_name' },
      { text: '💳 Реквизиты', callback_data: 'admin_requisites' }
    ],
    [
      { text: '📜 Политика конф.', callback_data: 'admin_set_privacy' },
      { text: '📄 Соглашение', callback_data: 'admin_set_terms' }
    ],
    [
      { text: '💱 Курс USDT', callback_data: 'admin_set_rate' },
      { text: '💰 Баланс юзера', callback_data: 'admin_user_balance' }
    ],
    [
      { text: '🤝 Реф. программа', callback_data: 'admin_ref_settings' },
      { text: '🎟 Промокоды', callback_data: 'admin_promos' }
    ],
    [
      { text: '📊 Экспорт в CSV', callback_data: 'admin_export_csv' },
      { text: '🌐 URL Mini App', callback_data: 'admin_set_miniapp' }
    ],
    [
      { text: '⭐️ Отзывы и рейтинг', callback_data: 'admin_reviews_settings' },
      { text: '📞 Поддержка', callback_data: 'admin_set_support' }
    ],
    [
      { text: '🤖 Токен CryptoBot', callback_data: 'admin_set_cryptobot' },
      { text: '🚀 Токен xRocket', callback_data: 'admin_set_xrocket' }
    ],
    [
      { text: '◀️ В клиентское меню', callback_data: 'back_to_main' }
    ]
  ];

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
});

// Admin: Referral Settings
bot.action('admin_ref_settings', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const enabled = db.getSetting('ref_system_enabled') === '1';
  const percent = db.getSetting('ref_reward_percent') || '10';

  const text = 
    `🤝 <b>Управление партнёрской программой</b>\n\n` +
    `• Статус: <b>${enabled ? 'ВКЛЮЧЕНА ✅' : 'ОТКЛЮЧЕНА ❌'}</b>\n` +
    `• Процент отчислений: <b>${percent}%</b>\n\n` +
    `<i>Когда программа выключена, кнопка партнерки и блок в Mini App полностью скрываются от пользователей.</i>`;

  const keyboard = [
    [{ text: enabled ? '🔴 Отключить партнёрку' : '🟢 Включить партнёрку', callback_data: 'admin_toggle_ref' }],
    [{ text: '✏️ Изменить процент отчислений', callback_data: 'admin_set_ref_percent' }],
    [{ text: '◀️ Назад в админку', callback_data: 'admin_main' }]
  ];

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
});

bot.action('admin_toggle_ref', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const enabled = db.getSetting('ref_system_enabled') === '1';
  db.setSetting('ref_system_enabled', enabled ? '0' : '1');
  await ctx.reply(enabled ? '❌ Партнёрская программа отключена.' : '✅ Партнёрская программа включена.');
});

bot.action('admin_set_ref_percent', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'admin_setting_ref_percent' });
  await ctx.reply('Введите процент вознаграждения для пригласившего (например, 10 или 15):');
});

// Admin: Reviews Settings
bot.action('admin_reviews_settings', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const enabled = db.getSetting('reviews_enabled') !== '0';

  const text =
    `⭐️ <b>Управление системой отзывов</b>\n\n` +
    `• Статус: <b>${enabled ? 'ВКЛЮЧЕНА ✅' : 'ОТКЛЮЧЕНА ❌'}</b>\n\n` +
    `<i>Когда система отзывов выключена, блоки и кнопки отзывов скрываются из магазина и бота.</i>`;

  const keyboard = [
    [{ text: enabled ? '🔴 Выключить отзывы' : '🟢 Включить отзывы', callback_data: 'admin_toggle_reviews' }],
    [{ text: '◀️ Назад в админку', callback_data: 'admin_main' }]
  ];

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
});

bot.action('admin_toggle_reviews', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const enabled = db.getSetting('reviews_enabled') !== '0';
  db.setSetting('reviews_enabled', enabled ? '0' : '1');
  const nowEnabled = !enabled;
  await ctx.reply(nowEnabled ? '✅ Система отзывов включена.' : '❌ Система отзывов отключена.');
});

// Admin: Promocodes
bot.action('admin_promos', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const promos = db.getPromoCodes();

  let text = `🎟 <b>Список промокодов:</b>\n\n`;
  if (promos.length === 0) text += `Активных промокодов нет.\n`;
  promos.forEach(p => {
    text += `• <code>${p.code}</code> — <b>+${p.reward} ₽</b> (Использовано: ${p.used_count}/${p.max_uses})\n`;
  });

  const buttons = promos.map(p => [
    { text: `🗑 Удалить: ${p.code}`, callback_data: `admin_del_promo_${p.id}` }
  ]);
  buttons.unshift([{ text: '➕ Создать промокод', callback_data: 'admin_add_promo' }]);
  buttons.push([{ text: '◀️ Назад в админку', callback_data: 'admin_main' }]);

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
});

bot.action('admin_add_promo', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'admin_promo_code' });
  await ctx.reply('Введите <b>название промокода</b> (например: START50):', { parse_mode: 'HTML' });
});

bot.action(/^admin_del_promo_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  db.deletePromoCode(parseInt(ctx.match[1]));
  await ctx.reply('✅ Промокод удален.');
});

// Admin: CSV Export
bot.action('admin_export_csv', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery('Формирование отчета...');

  const users = db.getAllUsers();
  const purchases = db.db.prepare('SELECT * FROM purchases ORDER BY id DESC').all();

  let csvContent = 'ID,Username,Name,Balance,Created\n';
  users.forEach(u => {
    csvContent += `"${u.id}","${u.username || ''}","${u.first_name || ''}","${u.balance}","${u.created_at}"\n`;
  });

  const fs = require('fs');
  const path = require('path');
  const usersCsvPath = path.join(__dirname, 'users_export.csv');
  fs.writeFileSync(usersCsvPath, csvContent, 'utf-8');

  let ordersCsv = 'ID,UserId,Product,Price,Date,Content\n';
  purchases.forEach(p => {
    ordersCsv += `"${p.id}","${p.user_id}","${p.product_title}","${p.price}","${p.created_at}","${p.delivered_content.replace(/"/g, '""')}"\n`;
  });
  const ordersCsvPath = path.join(__dirname, 'orders_export.csv');
  fs.writeFileSync(ordersCsvPath, ordersCsv, 'utf-8');

  await ctx.replyWithDocument({ source: usersCsvPath, filename: 'users.csv' }, { caption: '👥 Выгрузка базы пользователей' });
  await ctx.replyWithDocument({ source: ordersCsvPath, filename: 'orders.csv' }, { caption: '🛒 Выгрузка всех заказов' });
});
bot.action('admin_users_list', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const users = db.getAllUsers();
  let text = `👥 <b>Пользователи магазина (всего: ${users.length}):</b>\n\n`;

  const buttons = users.slice(0, 15).map(u => {
    const usernameStr = u.username ? `@${u.username}` : (u.first_name || 'Юзер');
    return [Markup.button.callback(`👤 ${usernameStr} (${u.balance} ₽)`, `admin_view_user_${u.id}`)];
  });

  buttons.push([Markup.button.callback('◀️ Назад в админку', 'admin_main')]);

  await ctx.editMessageText(text + `<i>Нажмите на пользователя для детальной информации и управления:</i>`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  });
});

// Admin: View Single User
bot.action(/^admin_view_user_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const targetId = parseInt(ctx.match[1]);
  const user = db.getUserById(targetId);

  if (!user) return ctx.reply('Пользователь не найден.');

  const purchases = db.getUserPurchases(targetId);

  let text = 
    `👤 <b>Карточка пользователя:</b>\n\n` +
    `🆔 <b>ID:</b> <code>${user.id}</code>\n` +
    `👤 <b>Имя:</b> ${user.first_name || '—'}\n` +
    `🌐 <b>Username:</b> ${user.username ? '@' + user.username : '—'}\n` +
    `💰 <b>Баланс:</b> <b>${user.balance.toFixed(2)} ₽</b>\n` +
    `📅 <b>Регистрация:</b> ${user.created_at}\n` +
    `🛍 <b>Всего покупок:</b> ${purchases.length} шт.\n\n`;

  if (purchases.length > 0) {
    text += `<b>Последние заказы:</b>\n`;
    purchases.slice(0, 3).forEach(p => {
      text += `• ${p.product_title} (${p.price} ₽)\n`;
    });
  }

  const buttons = [
    [
      Markup.button.callback('➕ Начислить 100 ₽', `admin_quick_bal_${user.id}_100`),
      Markup.button.callback('➕ Начислить 500 ₽', `admin_quick_bal_${user.id}_500`)
    ],
    [
      Markup.button.callback('✏️ Задать сумму баланса', `admin_custom_bal_${user.id}`),
      Markup.button.callback('✉️ Написать юзеру', `admin_msg_user_${user.id}`)
    ],
    [Markup.button.callback('◀️ К списку юзеров', 'admin_users_list')]
  ];

  await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^admin_quick_bal_(\d+)_(-?\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const targetId = parseInt(ctx.match[1]);
  const delta = parseFloat(ctx.match[2]);

  const newBal = db.updateUserBalance(targetId, delta);
  await ctx.reply(`✅ Баланс пользователя <code>${targetId}</code> успешно пополнен на ${delta} ₽. Текущий баланс: ${newBal} ₽`, { parse_mode: 'HTML' });

  try {
    await bot.telegram.sendMessage(targetId, `💰 Администратор начислил на ваш баланс <b>+${delta} ₽</b>!\nТекущий баланс: <b>${newBal} ₽</b>`, { parse_mode: 'HTML' });
  } catch (e) {}
});

bot.action(/^admin_custom_bal_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const targetId = parseInt(ctx.match[1]);
  userStates.set(ctx.from.id, { step: 'admin_user_balance_amount', targetUserId: targetId });
  await ctx.reply(`Введите сумму изменения баланса для ID <code>${targetId}</code> (например +250 или -100):`, { parse_mode: 'HTML' });
});

bot.action(/^admin_msg_user_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const targetId = parseInt(ctx.match[1]);
  userStates.set(ctx.from.id, { step: 'admin_sending_direct_msg', targetUserId: targetId });
  await ctx.reply(`Введите текст сообщения для отправки пользователю <code>${targetId}</code>:`, { parse_mode: 'HTML' });
});

// Admin: Broadcast
bot.action('admin_broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'admin_awaiting_broadcast_msg' });

  await ctx.reply(
    `📢 <b>Создание массовой рассылки</b>\n\n` +
    `Отправьте текст сообщения (поддерживается HTML-разметка, ссылки и форматирование).\n` +
    `Сообщение будет отправлено всем зарегистрированным пользователям бота.`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin_main')]]) }
  );
});

bot.action('admin_set_privacy', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'admin_setting_privacy' });
  const current = db.getSetting('privacy_policy_url') || 'не установлена';
  await ctx.reply(`Текущая ссылка: ${current}\n\nВведите URL политики конфиденциальности (или отправьте "-", чтобы удалить):`);
});

bot.action('admin_set_terms', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'admin_setting_terms' });
  const current = db.getSetting('terms_of_service_url') || 'не установлено';
  await ctx.reply(`Текущая ссылка: ${current}\n\nВведите URL пользовательского соглашения (или отправьте "-", чтобы удалить):`);
});

bot.action('admin_set_store_name', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'admin_setting_store_name' });
  await ctx.reply('Введите новое название магазина (отобразится в боте и Mini App):');
});

// Admin: Categories
bot.action('admin_categories', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const cats = db.getCategories();

  let text = `📂 <b>Список категорий:</b>\n\n`;
  if (cats.length === 0) text += `Категорий пока нет.\n`;
  cats.forEach(c => {
    text += `• ID: <code>${c.id}</code> — <b>${c.title}</b>\n`;
  });

  const buttons = cats.map(c => [
    Markup.button.callback(`🗑 Удалить: ${c.title}`, `admin_del_cat_${c.id}`)
  ]);
  buttons.unshift([Markup.button.callback('➕ Создать категорию', 'admin_add_cat')]);
  buttons.push([Markup.button.callback('◀️ Назад в админку', 'admin_main')]);

  await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

bot.action('admin_add_cat', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'admin_awaiting_cat_title' });
  await ctx.reply('Введите название новой категории:', {
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin_categories')]])
  });
});

bot.action(/^admin_del_cat_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  db.deleteCategory(parseInt(ctx.match[1]));
  await ctx.reply('✅ Категория удалена.');
  // Refresh view
  const cats = db.getCategories();
  const buttons = cats.map(c => [Markup.button.callback(`🗑 Удалить: ${c.title}`, `admin_del_cat_${c.id}`)]);
  buttons.unshift([Markup.button.callback('➕ Создать категорию', 'admin_add_cat')]);
  buttons.push([Markup.button.callback('◀️ Назад в админку', 'admin_main')]);
  await ctx.reply('📂 Обновленный список категорий:', Markup.inlineKeyboard(buttons));
});

// Admin: Products
bot.action('admin_products', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const prods = db.getProducts();

  let text = `🏷 <b>Список товаров:</b>\n\n`;
  if (prods.length === 0) text += `Товаров пока нет.\n`;
  prods.forEach(p => {
    let stock = 0;
    try { stock = JSON.parse(p.content_pool || '[]').length; } catch(e) {}
    text += `• ID: <code>${p.id}</code> | <b>${p.title}</b> | ${p.price} ₽ | Остаток: ${stock} шт.\n`;
  });

  const buttons = prods.map(p => [
    Markup.button.callback(`📦 Пополнить ключи: ${p.title}`, `admin_stock_prod_${p.id}`),
    Markup.button.callback(`🗑 Удалить`, `admin_del_prod_${p.id}`)
  ]);
  buttons.unshift([Markup.button.callback('➕ Добавить новый товар', 'admin_add_prod')]);
  buttons.push([Markup.button.callback('◀️ Назад в админку', 'admin_main')]);

  await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

bot.action('admin_add_prod', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const cats = db.getCategories();
  if (cats.length === 0) {
    return ctx.reply('Сначала создайте хотя бы одну категорию!', {
      ...Markup.inlineKeyboard([[Markup.button.callback('📂 Категории', 'admin_categories')]])
    });
  }

  const buttons = cats.map(c => [Markup.button.callback(c.title, `admin_pick_cat_for_prod_${c.id}`)]);
  buttons.push([Markup.button.callback('❌ Отмена', 'admin_products')]);

  await ctx.reply('Выберите категорию для нового товара:', Markup.inlineKeyboard(buttons));
});

bot.action(/^admin_pick_cat_for_prod_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const catId = parseInt(ctx.match[1]);
  userStates.set(ctx.from.id, { step: 'admin_prod_title', catId });
  await ctx.reply('Введите <b>название товара</b>:', { parse_mode: 'HTML' });
});

bot.action(/^admin_del_prod_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  db.deleteProduct(parseInt(ctx.match[1]));
  await ctx.reply('✅ Товар удален.');
});

bot.action(/^admin_stock_prod_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const prodId = parseInt(ctx.match[1]);
  const p = db.getProduct(prodId);
  if (!p) return;

  userStates.set(ctx.from.id, { step: 'admin_awaiting_keys', prodId });
  await ctx.reply(
    `📦 <b>Пополнение товара «${p.title}»</b>\n\n` +
    `Отправьте список цифровых товаров (ключи, аккаунты, ссылки).\n` +
    `Каждый элемент с новой строки:`,
    { parse_mode: 'HTML' }
  );
});

// Admin: Settings prompts
bot.action('admin_requisites', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const card = db.getSetting('card_requisites');
  const sbp = db.getSetting('sbp_requisites');

  const text = 
    `💳 <b>Текущие реквизиты:</b>\n\n` +
    `<b>Карта:</b>\n<code>${card}</code>\n\n` +
    `<b>СБП:</b>\n<code>${sbp}</code>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('Изменить Карту', 'admin_set_card')],
    [Markup.button.callback('Изменить СБП', 'admin_set_sbp')],
    [Markup.button.callback('◀️ Назад', 'admin_main')]
  ]);
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
});

bot.action('admin_set_card', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'admin_setting_card' });
  await ctx.reply('Введите новые реквизиты для банковской карты:');
});

bot.action('admin_set_sbp', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'admin_setting_sbp' });
  await ctx.reply('Введите новые реквизиты для СБП (номер телефона, банк, имя):');
});

bot.action('admin_set_rate', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'admin_setting_rate' });
  await ctx.reply('Введите курс 1 USDT в рублях (например, 96.5):');
});

bot.action('admin_set_cryptobot', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'admin_setting_cryptobot' });
  await ctx.reply('Введите API токен CryptoBot (полученный в @CryptoBot -> Crypto Pay):');
});

bot.action('admin_set_xrocket', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'admin_setting_xrocket' });
  await ctx.reply('Введите API ключ xRocket (полученный в @xrocket -> Pay):');
});

bot.action('admin_set_support', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'admin_setting_support' });
  await ctx.reply('Введите контакт поддержки (например: @admin_username):');
});

bot.action('admin_set_miniapp', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'admin_setting_miniapp' });
  await ctx.reply('Введите полный URL для Mini App (например https://xxxx.trycloudflare.com):');
});

bot.action('admin_user_balance', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'admin_user_balance_target' });
  await ctx.reply('Введите Telegram ID пользователя, которому нужно изменить баланс:');
});

// Admin Approval of deposits
bot.action(/^adm_approve_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const depId = parseInt(ctx.match[1]);
  const dep = db.getDeposit(depId);

  if (!dep || dep.status !== 'pending') {
    return ctx.reply('Заявка уже обработана или не найдена.');
  }

  db.updateDepositStatus(depId, 'approved');
  const newBal = db.updateUserBalance(dep.user_id, dep.amount);

  // Referral bonus processing
  const user = db.getUserById(dep.user_id);
  const refEnabled = db.getSetting('ref_system_enabled') === '1';
  if (refEnabled && user && user.referrer_id) {
    const percent = parseFloat(db.getSetting('ref_reward_percent') || '10');
    const bonus = Math.round((dep.amount * percent) / 100);
    if (bonus > 0) {
      const refBal = db.updateUserBalance(user.referrer_id, bonus);
      bot.telegram.sendMessage(
        user.referrer_id,
        `🎁 <b>Партнёрский бонус!</b>\n\n` +
        `Ваш реферал пополнил баланс на <b>${dep.amount} ₽</b>.\n` +
        `Вам начислено <b>+${bonus} ₽</b> (${percent}%).\n` +
        `Ваш текущий баланс: <b>${refBal.toFixed(2)} ₽</b>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  }

  await ctx.editMessageCaption(
    `${ctx.callbackQuery.message.caption || ''}\n\n✅ <b>ОДОБРЕНО администратором!</b> Зачислено: ${dep.amount} ₽`,
    { parse_mode: 'HTML' }
  );

  // Notify user
  try {
    await bot.telegram.sendMessage(
      dep.user_id,
      `✅ <b>Ваш платёж на сумму ${dep.amount} ₽ успешно одобрен!</b>\n` +
      `💰 Текущий баланс: <b>${newBal.toFixed(2)} ₽</b>`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('Notify user error:', e.message);
  }
});

bot.action(/^adm_reject_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const depId = parseInt(ctx.match[1]);
  const dep = db.getDeposit(depId);

  if (!dep || dep.status !== 'pending') {
    return ctx.reply('Заявка уже обработана или не найдена.');
  }

  db.updateDepositStatus(depId, 'rejected');

  await ctx.editMessageCaption(
    `${ctx.callbackQuery.message.caption || ''}\n\n❌ <b>ОТКЛОНЕНО администратором!</b>`,
    { parse_mode: 'HTML' }
  );

  // Notify user
  try {
    await bot.telegram.sendMessage(
      dep.user_id,
      `❌ <b>Ваш платёж на сумму ${dep.amount} ₽ был отклонен администратором.</b>\n` +
      `Если произошла ошибка, свяжитесь с поддержкой.`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('Notify user error:', e.message);
  }
});

// Photos handler (for deposit proofs and admin product creation)
bot.on('photo', async (ctx) => {
  const st = userStates.get(ctx.from.id);
  const photo = ctx.message.photo[ctx.message.photo.length - 1]; // highest res

  // Admin adding product photo directly by sending image
  if (st && st.step === 'admin_prod_image' && isAdmin(ctx)) {
    try {
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);
      const https = require('https');
      const fs = require('fs');
      const path = require('path');

      const uploadsDir = path.join(__dirname, 'public', 'uploads');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }

      const filename = `prod_${Date.now()}_${photo.file_id.slice(-8)}.jpg`;
      const localPath = path.join(uploadsDir, filename);

      await new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(localPath);
        https.get(fileLink.href, (response) => {
          response.pipe(fileStream);
          fileStream.on('finish', () => {
            fileStream.close();
            resolve();
          });
        }).on('error', (err) => {
          fs.unlink(localPath, () => {});
          reject(err);
        });
      });

      st.imageUrl = `/uploads/${filename}`;
      st.step = 'admin_prod_price';
      await ctx.reply('✅ Фото сохранено!\n\nТеперь введите <b>стоимость товара в рублях</b> (например, 150):', { parse_mode: 'HTML' });
      return;
    } catch (err) {
      console.error('Error downloading product photo:', err);
      // Fallback: save photo file_id directly
      st.imageUrl = photo.file_id;
      st.step = 'admin_prod_price';
      await ctx.reply('✅ Фото принято!\n\nТеперь введите <b>стоимость товара в рублях</b> (например, 150):', { parse_mode: 'HTML' });
      return;
    }
  }

  if (st && st.step === 'awaiting_payment_receipt') {
    userStates.delete(ctx.from.id);
    const dep = db.getDeposit(st.depositId);
    if (!dep) return ctx.reply('Заявка не найдена.');

    // Forward to admin
    await ctx.reply('✅ Чек принят и отправлен на верификацию администратору! Ожидайте зачисления баланса.');

    const adminKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Одобрить', `adm_approve_${dep.id}`),
        Markup.button.callback('❌ Отклонить', `adm_reject_${dep.id}`)
      ]
    ]);

    await bot.telegram.sendPhoto(
      ADMIN_ID,
      photo.file_id,
      {
        caption: 
          `🔔 <b>Новая заявка на пополнение #${dep.id}</b>\n\n` +
          `👤 Пользователь: <code>${ctx.from.id}</code> (@${ctx.from.username || 'нет'})\n` +
          `💰 Сумма: <b>${dep.amount} ₽</b>\n` +
          `Способ: <b>${dep.method.toUpperCase()}</b>\n` +
          `Дата: ${dep.created_at}`,
        parse_mode: 'HTML',
        ...adminKeyboard
      }
    );
    return;
  }

  // If user sent a photo without active state, check if they have a pending deposit
  const pendingDep = db.db.prepare('SELECT * FROM deposits WHERE user_id = ? AND status = "pending" ORDER BY id DESC LIMIT 1').get(ctx.from.id);
  if (pendingDep) {
    const adminKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Одобрить', `adm_approve_${pendingDep.id}`),
        Markup.button.callback('❌ Отклонить', `adm_reject_${pendingDep.id}`)
      ]
    ]);

    await ctx.reply('✅ Скриншот чека отправлен администратору на проверку.');
    await bot.telegram.sendPhoto(
      ADMIN_ID,
      photo.file_id,
      {
        caption: 
          `🔔 <b>Чек по заявке #${pendingDep.id}</b>\n\n` +
          `👤 Пользователь: <code>${ctx.from.id}</code> (@${ctx.from.username || 'нет'})\n` +
          `💰 Сумма: <b>${pendingDep.amount} ₽</b>\n` +
          `Способ: <b>${pendingDep.method.toUpperCase()}</b>`,
        parse_mode: 'HTML',
        ...adminKeyboard
      }
    );
    return;
  }

  await ctx.reply('Если это чек пополнения, сначала создайте заявку через меню «Пополнить баланс».');
});

// Text message handler for multistep wizards
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  const st = userStates.get(userId);

  if (!st) return;

  // User promo input
  if (st.step === 'awaiting_promo_input') {
    userStates.delete(userId);
    const resPromo = db.activatePromoCode(userId, text);
    if (resPromo.ok) {
      await ctx.reply(`🎉 <b>Промокод активирован!</b>\nНа ваш баланс зачислено <b>+${resPromo.reward} ₽</b>.\nТекущий баланс: <b>${resPromo.balance.toFixed(2)} ₽</b>`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(`❌ ${resPromo.error || 'Ошибка активации промокода'}`);
    }
    return;
  }

  // Deposit amount step
  if (st.step === 'awaiting_deposit_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount < 10) {
      return ctx.reply('Пожалуйста, введите корректное число от 10 ₽.');
    }

    userStates.delete(userId);
    const method = st.method;

    if (method === 'card' || method === 'sbp') {
      const deposit = db.createDeposit(userId, amount, method);
      const reqs = method === 'card' ? db.getSetting('card_requisites') : db.getSetting('sbp_requisites');

      userStates.set(userId, { step: 'awaiting_payment_receipt', depositId: deposit.lastInsertRowid });

      const replyText = 
        `💳 <b>Заявка на пополнение #${deposit.lastInsertRowid}</b>\n\n` +
        `Способ: <b>${method === 'card' ? 'Банковская карта' : 'СБП'}</b>\n` +
        `Сумма к оплате: <b>${amount} ₽</b>\n\n` +
        `Реквизиты для оплаты:\n<code>${reqs}</code>\n\n` +
        `📸 <b>Теперь пришлите скриншот чека в ответ на это сообщение!</b>`;

      // Extract raw digits for quick copy button
      const cleanDigits = (reqs.match(/[\d+]+/g) || []).join('');

      const buttons = [
        [{ text: '📋 Скопировать реквизиты', copy_text: { text: cleanDigits || reqs } }],
        [{ text: '❌ Отмена', callback_data: 'back_to_main' }]
      ];

      return ctx.reply(replyText, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons }
      });
    }

    if (method === 'cryptobot') {
      try {
        const inv = await createCryptoBotInvoice(amount);
        db.createDeposit(userId, amount, 'cryptobot', null, inv.invoiceId);

        return ctx.reply(
          `🤖 <b>Оплата через Crypto Bot</b>\n\n` +
          `Сумма: <b>${amount} ₽</b> (≈ ${inv.amountUsdt} USDT)\n\n` +
          `Нажмите кнопку ниже для моментальной оплаты:`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url('💸 Оплатить счёт в Crypto Bot', inv.payUrl)],
              [Markup.button.callback('◀️ Назад', 'back_to_main')]
            ])
          }
        );
      } catch (err) {
        return ctx.reply(`❌ Ошибка Crypto Bot: ${err.message}`);
      }
    }

    if (method === 'xrocket') {
      try {
        const inv = await createXRocketInvoice(amount);
        db.createDeposit(userId, amount, 'xrocket', null, inv.invoiceId);

        return ctx.reply(
          `🚀 <b>Оплата через xRocket</b>\n\n` +
          `Сумма: <b>${amount} ₽</b> (≈ ${inv.amountUsdt} USDT)\n\n` +
          `Нажмите кнопку ниже для моментальной оплаты:`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url('💸 Оплатить счёт в xRocket', inv.payUrl)],
              [Markup.button.callback('◀️ Назад', 'back_to_main')]
            ])
          }
        );
      } catch (err) {
        return ctx.reply(`❌ Ошибка xRocket: ${err.message}`);
      }
    }
  }

  // User review steps
  if (st.step === 'awaiting_review_comment') {
    const prodId = st.productId;
    const rating = st.rating;
    const comment = text === '-' ? '' : text;
    userStates.delete(userId);

    const reviewsEnabled = db.getSetting('reviews_enabled') !== '0';
    if (!reviewsEnabled) {
      return ctx.reply('❌ Система отзывов временно отключена администратором.');
    }

    const hasBought = db.hasUserPurchasedProduct(userId, prodId);
    if (!hasBought) {
      return ctx.reply('❌ Для оставления отзыва необходимо сначала купить этот товар.');
    }

    const userName = ctx.from.first_name || (ctx.from.username ? '@' + ctx.from.username : 'Покупатель');
    db.addReview(prodId, userId, userName, rating, comment);

    return ctx.reply(
      `⭐️ <b>Спасибо за отзыв!</b>\n\n` +
      `Ваша оценка (${rating}/5) успешно сохранена и отображается в магазине.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('◀️ В меню', 'back_to_main')]])
      }
    );
  }

  // Admin steps
  if (!isAdmin(ctx)) return;

  if (st.step === 'admin_awaiting_cat_title') {
    userStates.delete(userId);
    db.addCategory(text);
    await ctx.reply(`✅ Категория «${text}» успешно добавлена!`);
    return;
  }

  if (st.step === 'admin_prod_title') {
    st.title = text;
    st.step = 'admin_prod_desc';
    await ctx.reply('Введите <b>описание товара</b> (или отправьте "-", если без описания):', { parse_mode: 'HTML' });
    return;
  }

  if (st.step === 'admin_prod_desc') {
    st.description = text === '-' ? '' : text;
    st.step = 'admin_prod_image';
    await ctx.reply('Отправьте <b>фото товара прямо сюда в чат</b> (или отправьте "-", если без фото):', { parse_mode: 'HTML' });
    return;
  }

  if (st.step === 'admin_prod_image') {
    st.imageUrl = (text === '-' || text === '0') ? null : text;
    st.step = 'admin_prod_price';
    await ctx.reply('Введите <b>стоимость товара в рублях</b> (например, 150):', { parse_mode: 'HTML' });
    return;
  }

  if (st.step === 'admin_prod_price') {
    const price = parseFloat(text);
    if (isNaN(price) || price < 0) return ctx.reply('Неверная цена, введите число:');
    st.price = price;
    st.step = 'admin_prod_initial_keys';
    await ctx.reply(
      'Отправьте <b>ключи/аккаунты</b> для этого товара (каждый с новой строки) или отправьте 0, если добавите позже:',
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (st.step === 'admin_prod_initial_keys') {
    const keys = text === '0' ? [] : text.split('\n').map(s => s.trim()).filter(Boolean);
    db.addProduct(st.catId, st.title, st.description, st.price, keys, st.imageUrl);
    userStates.delete(userId);
    await ctx.reply(`✅ Товар «${st.title}» успешно добавлен! Загружено ключей: ${keys.length} шт.`);
    return;
  }

  if (st.step === 'admin_awaiting_keys') {
    const p = db.getProduct(st.prodId);
    let pool = [];
    try { pool = JSON.parse(p.content_pool || '[]'); } catch(e) {}
    const newKeys = text.split('\n').map(s => s.trim()).filter(Boolean);
    pool.push(...newKeys);
    db.updateProductPool(st.prodId, pool);
    userStates.delete(userId);
    await ctx.reply(`✅ Добавлено ${newKeys.length} шт. Всего в наличии: ${pool.length} шт.`);
    return;
  }

  if (st.step === 'admin_setting_card') {
    db.setSetting('card_requisites', text);
    userStates.delete(userId);
    await ctx.reply('✅ Реквизиты банковской карты обновлены.');
    return;
  }

  if (st.step === 'admin_setting_sbp') {
    db.setSetting('sbp_requisites', text);
    userStates.delete(userId);
    await ctx.reply('✅ Реквизиты СБП обновлены.');
    return;
  }

  if (st.step === 'admin_setting_rate') {
    const rate = parseFloat(text);
    if (isNaN(rate) || rate <= 0) return ctx.reply('Неверный курс.');
    db.setSetting('usdt_rate', rate.toString());
    userStates.delete(userId);
    await ctx.reply(`✅ Курс USDT обновлен: 1 USDT = ${rate} ₽`);
    return;
  }

  if (st.step === 'admin_setting_cryptobot') {
    db.setSetting('cryptobot_token', text);
    userStates.delete(userId);
    await ctx.reply('✅ Токен CryptoBot сохранен.');
    return;
  }

  if (st.step === 'admin_setting_xrocket') {
    db.setSetting('xrocket_token', text);
    userStates.delete(userId);
    await ctx.reply('✅ Токен xRocket сохранен.');
    return;
  }

  if (st.step === 'admin_setting_support') {
    db.setSetting('support_contact', text);
    userStates.delete(userId);
    await ctx.reply(`✅ Контакт поддержки обновлен: ${text}`);
    return;
  }

  if (st.step === 'admin_setting_miniapp') {
    db.setSetting('miniapp_url', text);
    userStates.delete(userId);
    await ctx.reply(`✅ URL Mini App обновлен: ${text}`);
    return;
  }

  if (st.step === 'admin_setting_privacy') {
    const val = (text === '-' || text.toLowerCase() === 'удалить') ? '' : text;
    db.setSetting('privacy_policy_url', val);
    userStates.delete(userId);
    await ctx.reply(val ? `✅ Ссылка на Политику конфиденциальности сохранена: ${val}` : `✅ Политика конфиденциальности отключена в Mini App.`);
    return;
  }

  if (st.step === 'admin_setting_terms') {
    const val = (text === '-' || text.toLowerCase() === 'удалить') ? '' : text;
    db.setSetting('terms_of_service_url', val);
    userStates.delete(userId);
    await ctx.reply(val ? `✅ Ссылка на Пользовательское соглашение сохранена: ${val}` : `✅ Пользовательское соглашение отключено в Mini App.`);
    return;
  }

  if (st.step === 'admin_setting_ref_percent') {
    const p = parseFloat(text);
    if (isNaN(p) || p < 0 || p > 100) return ctx.reply('Введите число от 0 до 100:');
    db.setSetting('ref_reward_percent', String(p));
    userStates.delete(userId);
    await ctx.reply(`✅ Процент партнерских отчислений установлен: <b>${p}%</b>`, { parse_mode: 'HTML' });
    return;
  }

  if (st.step === 'admin_promo_code') {
    st.promoCode = text.toUpperCase();
    st.step = 'admin_promo_reward';
    await ctx.reply(`Введите <b>сумму вознаграждения в рублях</b> для кода ${st.promoCode}:`, { parse_mode: 'HTML' });
    return;
  }

  if (st.step === 'admin_promo_reward') {
    const reward = parseFloat(text);
    if (isNaN(reward) || reward <= 0) return ctx.reply('Введите положительное число:');
    st.promoReward = reward;
    st.step = 'admin_promo_uses';
    await ctx.reply(`Введите <b>максимальное количество активаций</b> промокода (например: 10):`, { parse_mode: 'HTML' });
    return;
  }

  if (st.step === 'admin_promo_uses') {
    const uses = parseInt(text);
    if (isNaN(uses) || uses <= 0) return ctx.reply('Введите число больше нуля:');
    try {
      db.createPromoCode(st.promoCode, st.promoReward, uses);
      await ctx.reply(`✅ Промокод <code>${st.promoCode}</code> на <b>${st.promoReward} ₽</b> (${uses} активаций) успешно создан!`, { parse_mode: 'HTML' });
    } catch(err) {
      await ctx.reply(`❌ Ошибка: такой промокод уже существует.`);
    }
    userStates.delete(userId);
    return;
  }

  if (st.step === 'admin_setting_store_name') {
    db.setSetting('store_name', text);
    userStates.delete(userId);
    await ctx.reply(`✅ Название магазина обновлено на «<b>${text}</b>»!`, { parse_mode: 'HTML' });
    return;
  }

  if (st.step === 'admin_sending_direct_msg') {
    const targetId = st.targetUserId;
    userStates.delete(userId);
    try {
      await bot.telegram.sendMessage(
        targetId,
        `📩 <b>Сообщение от администрации магазина:</b>\n\n${text}`,
        { parse_mode: 'HTML' }
      );
      await ctx.reply(`✅ Сообщение успешно доставлено пользователю <code>${targetId}</code>.`, { parse_mode: 'HTML' });
    } catch (e) {
      await ctx.reply(`❌ Не удалось доставить сообщение: ${e.message}`);
    }
    return;
  }

  if (st.step === 'admin_awaiting_broadcast_msg') {
    userStates.delete(userId);
    const users = db.getAllUsers();
    await ctx.reply(`⏳ Запуск рассылки на ${users.length} пользователей...`);

    let sent = 0;
    let failed = 0;

    for (const u of users) {
      try {
        await bot.telegram.sendMessage(u.id, text, { parse_mode: 'HTML' });
        sent++;
      } catch (err) {
        failed++;
      }
      // slight delay to prevent rate limits
      await new Promise(r => setTimeout(r, 60));
    }

    await ctx.reply(
      `📊 <b>Рассылка завершена!</b>\n\n` +
      `✅ Успешно доставлено: <b>${sent}</b>\n` +
      `❌ Ошибок / бот заблокирован: <b>${failed}</b>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (st.step === 'admin_user_balance_target') {
    const targetId = parseInt(text);
    const targetUser = db.db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!targetUser) return ctx.reply('Пользователь с таким ID не найден.');
    st.targetUserId = targetId;
    st.step = 'admin_user_balance_amount';
    await ctx.reply(`Пользователь найден (${targetUser.first_name || ''}, текущий баланс: ${targetUser.balance} ₽).\nВведите сумму пополнения (+100) или списания (-100):`);
    return;
  }

  if (st.step === 'admin_user_balance_amount') {
    const delta = parseFloat(text);
    if (isNaN(delta)) return ctx.reply('Неверное число.');
    const newBal = db.updateUserBalance(st.targetUserId, delta);
    userStates.delete(userId);
    await ctx.reply(`✅ Баланс пользователя <code>${st.targetUserId}</code> изменен на ${delta} ₽. Новый баланс: ${newBal} ₽`, { parse_mode: 'HTML' });
    try {
      await bot.telegram.sendMessage(st.targetUserId, `ℹ️ Администратор скорректировал ваш баланс на ${delta > 0 ? '+' : ''}${delta} ₽. Текущий баланс: ${newBal} ₽`);
    } catch(e) {}
    return;
  }
});

module.exports = { bot, ADMIN_ID };
