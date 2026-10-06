const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
const { startStoreBot, stopStoreBot, getPublicMiniAppUrl } = require('./botManager');
const { createServer } = require('./server');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Master Bot Token
const MASTER_BOT_TOKEN = '8639107571:AAFiqtvgHY4PaknT7pisSS4jipfdw6RVgU4';
const PORT = process.env.PORT || 3001;
const VERCEL_DOCS_URL = 'https://bot-factory-docs.vercel.app';

function getBaseUrl() {
  const custom = db.getPlatformSetting('custom_base_url');
  if (custom) return custom.replace(/\/+$/, '');
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  return 'https://bot-factory-platform.vercel.app';
}

// Auto Tunnel Service (Pinggy HTTPS with auto-reconnect)
let tunnelProcess = null;
function startTunnelService() {
  console.log('[Tunnel] Launching HTTPS public tunnel on port ' + PORT + '...');
  tunnelProcess = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ServerAliveInterval=30',
    '-p', '443',
    '-R0:localhost:' + PORT,
    'a.pinggy.io'
  ]);

  const handleData = (buf) => {
    const text = buf.toString();
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.(?:free\.pinggy\.net|run\.pinggy-free\.link)/);
    if (match) {
      const publicUrl = match[0];
      const currentPerm = db.getPlatformSetting('permanent_base_url');
      if (!currentPerm) {
        // Fix permanent domain on first generation so it never changes!
        db.setPlatformSetting('permanent_base_url', publicUrl);
        console.log(`\n======================================================`);
        console.log(`[Platform] Permanent Free Base URL locked: ${publicUrl}`);
        console.log(`======================================================\n`);
      }
      db.setPlatformSetting('tunnel_public_url', publicUrl);
    }
  };

  tunnelProcess.stdout.on('data', handleData);
  tunnelProcess.stderr.on('data', handleData);

  tunnelProcess.on('close', (code) => {
    console.log(`[Tunnel] Exited with code ${code}. Reconnecting in 5s...`);
    setTimeout(startTunnelService, 5000);
  });
}

const masterBot = new Telegraf(MASTER_BOT_TOKEN);
const userStates = new Map();

masterBot.catch((err, ctx) => {
  console.error('[MasterBot Error]:', err.message);
});

// Master Main Keyboard
function getMasterKeyboard() {
  return Markup.inlineKeyboard([
    [{ text: '➕ Создать магазин', callback_data: 'create_store' }],
    [
      { text: '📱 Мои магазины', callback_data: 'my_stores' },
      { text: '🔑 API для разработчиков', callback_data: 'dev_api' }
    ],
    [
      { text: '📚 Документация API', callback_data: 'docs_menu' },
      { text: '🌐 Настроить Base URL', callback_data: 'set_base_url' }
    ]
  ]);
}

masterBot.start(async (ctx) => {
  db.getPlatformUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  userStates.delete(ctx.from.id);

  const text =
    `🏭 <b>Платформа-конструктор ботов-магазинов</b>\n\n` +
    `Привет, <b>${ctx.from.first_name || 'Разработчик'}</b>!\n` +
    `Здесь вы можете за пару секунд создать собственного бота-магазина со встроенной Mini App и получить API токен для разработчиков.\n\n` +
    `🌐 <b>Текущий Base URL:</b>\n<code>${getBaseUrl()}</code>\n\n` +
    `Выберите действие:`;

  await ctx.reply(text, { parse_mode: 'HTML', ...getMasterKeyboard() });
});

masterBot.action('back_master', async (ctx) => {
  await ctx.answerCbQuery();
  userStates.delete(ctx.from.id);
  await ctx.reply('📋 Главное меню платформы:', getMasterKeyboard());
});

// Step-by-step Store Creation
masterBot.action('create_store', async (ctx) => {
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'awaiting_bot_token' });

  const text =
    `🛠 <b>Создание нового бота-магазина</b>\n\n` +
    `<b>Шаг 1 из 2:</b>\n` +
    `Отправьте токен бота, полученный от @BotFather:`;

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'back_master')]])
  });
});

// My Stores
masterBot.action('my_stores', async (ctx) => {
  await ctx.answerCbQuery();
  const stores = db.getStoresByOwner(ctx.from.id);

  if (stores.length === 0) {
    return ctx.reply('У вас пока нет созданных магазинов.', Markup.inlineKeyboard([
      [Markup.button.callback('➕ Создать магазин', 'create_store')],
      [Markup.button.callback('◀️ Назад', 'back_master')]
    ]));
  }

  const buttons = stores.map(s => [
    Markup.button.callback(`🛍 ${s.store_name} (@${s.bot_username || s.id})`, `manage_store_${s.id}`)
  ]);
  buttons.push([Markup.button.callback('◀️ В меню', 'back_master')]);

  await ctx.reply('📱 <b>Ваши магазины:</b>', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  });
});

// Manage Single Store
masterBot.action(/^manage_store_([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const storeId = ctx.match[1];
  const s = db.getStore(storeId);
  if (!s || s.owner_id !== ctx.from.id) return ctx.reply('Магазин не найден.');

  const stats = db.getStoreStats(storeId);
  const appUrl = getPublicMiniAppUrl(storeId, getBaseUrl());

  const text =
    `🛍 <b>Управление магазином: ${s.store_name}</b>\n\n` +
    `• Бот: @${s.bot_username || '—'}\n` +
    `• Статус: <b>${s.status === 'active' ? '🟢 Работает' : '🔴 Остановлен'}</b>\n` +
    `• ID админа магазина: <code>${s.admin_id}</code>\n` +
    `• Покупателей: <b>${stats.users}</b>\n` +
    `• Заказов: <b>${stats.ordersCount}</b> (на <b>${stats.ordersVolume} ₽</b>)\n\n` +
    `⚡ <b>Ссылка на Mini App магазина:</b>\n<code>${appUrl}</code>`;

  const buttons = [
    [
      { text: s.status === 'active' ? '⏸ Остановить' : '▶️ Запустить', callback_data: `toggle_store_${s.id}` },
      { text: '🗑 Удалить', callback_data: `del_store_${s.id}` }
    ],
    [
      { text: '🔑 Создать API токен', callback_data: `create_api_${s.id}` }
    ],
    [
      { text: '◀️ К списку магазинов', callback_data: 'my_stores' }
    ]
  ];

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
});

// Toggle start/stop store bot
masterBot.action(/^toggle_store_([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const storeId = ctx.match[1];
  const s = db.getStore(storeId);
  if (!s || s.owner_id !== ctx.from.id) return;

  if (s.status === 'active') {
    stopStoreBot(storeId);
    db.updateStoreStatus(storeId, 'stopped');
    await ctx.reply(`🔴 Магазин «${s.store_name}» остановлен.`);
  } else {
    db.updateStoreStatus(storeId, 'active');
    const started = await startStoreBot(db.getStore(storeId), getBaseUrl);
    await ctx.reply(started ? `🟢 Магазин «${s.store_name}» успешно запущен!` : `❌ Ошибка запуска. Проверьте токен бота.`);
  }
});

// Delete store
masterBot.action(/^del_store_([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const storeId = ctx.match[1];
  const s = db.getStore(storeId);
  if (!s || s.owner_id !== ctx.from.id) return;

  stopStoreBot(storeId);
  db.deleteStore(storeId);
  await ctx.reply(`🗑 Магазин «${s.store_name}» полностью удалён.`);
});

// Developer API management
masterBot.action('dev_api', async (ctx) => {
  await ctx.answerCbQuery();
  const keys = db.getApiKeys(ctx.from.id);

  let text = `🔑 <b>API для разработчиков (создание и управление ботами через код)</b>\n\n`;
  if (keys.length === 0) {
    text += `У вас пока нет активных API ключей.\nНажмите кнопку ниже, чтобы сгенерировать токен доступа.`;
  } else {
    text += `Ваши API токены:\n\n`;
    keys.forEach((k, idx) => {
      text += `<b>${idx + 1}. ${k.name}</b>\n<code>${k.key}</code>\n\n`;
    });
  }

  const buttons = [
    [{ text: '➕ Сгенерировать новый API ключ', callback_data: 'create_dev_key' }],
    [Markup.button.callback('📚 Документация в боте', 'docs_menu')],
    [{ text: '🌐 Веб-документация (Vercel)', url: VERCEL_DOCS_URL }],
    [Markup.button.callback('◀️ В меню', 'back_master')]
  ];

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  });
});

masterBot.action('create_dev_key', async (ctx) => {
  await ctx.answerCbQuery();
  const rawKey = 'sk_live_' + crypto.randomBytes(20).toString('hex');
  db.createApiKey(rawKey, ctx.from.id, `Developer Key #${Date.now().toString().slice(-4)}`);

  const text =
    `✅ <b>Новый API ключ успешно выпущен!</b>\n\n` +
    `Токен:\n<code>${rawKey}</code>\n\n` +
    `Используйте его в заголовке:\n<code>Authorization: Bearer ${rawKey}</code>\n\n` +
    `С его помощью вы можете создавать ботов программно через <code>POST /api/v1/stores</code>.`;

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📚 Открыть документацию', 'docs_menu')],
      [Markup.button.callback('◀️ К списку ключей', 'dev_api')]
    ])
  });
});

// Documentation in Telegraf
masterBot.action('docs_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const baseUrl = getBaseUrl();

  const text =
    `📚 <b>Документация REST API для создания ботов и управления</b>\n\n` +
    `API позволяет программно создавать ботов-магазинов, запускать их и управлять ими из любого приложения или скрипта.\n\n` +
    `🌐 <b>Base URL:</b>\n<code>${baseUrl}</code>\n\n` +
    `🔑 <b>Авторизация:</b>\nПередавайте токен в заголовке:\n` +
    `<code>Authorization: Bearer sk_live_...</code>\nили\n` +
    `<code>X-API-Key: sk_live_...</code>\n\n` +
    `<b>Доступные методы API:</b>`;

  const buttons = [
    [
      Markup.button.callback('🤖 Создать бота (POST)', 'docs_create_bot'),
      Markup.button.callback('📱 Список ботов (GET)', 'docs_list_bots')
    ],
    [
      Markup.button.callback('🗑 Удалить бота (DELETE)', 'docs_del_bot')
    ],
    [
      { text: '🌐 Открыть веб-версию (Vercel)', url: VERCEL_DOCS_URL }
    ],
    [
      Markup.button.callback('◀️ В главное меню', 'back_master')
    ]
  ];

  await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

masterBot.action('docs_create_bot', async (ctx) => {
  await ctx.answerCbQuery();
  const text =
    `🤖 <b>API: Создание и запуск бота-магазина</b>\n\n` +
    `Создаёт и мгновенно запускает нового Telegram-бота с привязанной Mini App.\n\n` +
    `<code>POST /api/v1/stores</code>\n\n` +
    `<b>Заголовки:</b>\n` +
    `• <code>Authorization: Bearer sk_live_...</code>\n` +
    `• <code>Content-Type: application/json</code>\n\n` +
    `<b>Тело запроса (JSON):</b>\n` +
    `<pre>{\n  "botToken": "123456:ABC-DEF...",\n  "adminId": 8282599467,\n  "storeName": "Мой Магазин"\n}</pre>\n\n` +
    `<b>Пример ответа (JSON):</b>\n` +
    `<pre>{\n  "ok": true,\n  "storeId": "shop_a1b2",\n  "botUsername": "my_shop_bot",\n  "storeName": "Мой Магазин",\n  "miniAppUrl": "${getBaseUrl()}/app?shop=shop_a1b2"\n}</pre>`;

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('◀️ К документации', 'docs_menu')]])
  });
});

masterBot.action('docs_list_bots', async (ctx) => {
  await ctx.answerCbQuery();
  const text =
    `📱 <b>API: Получение списка ваших ботов</b>\n\n` +
    `Возвращает все магазины, созданные через ваш аккаунт/токен.\n\n` +
    `<code>GET /api/v1/stores</code>\n\n` +
    `<b>Пример запроса cURL:</b>\n` +
    `<pre>curl -H "Authorization: Bearer sk_live_..." \\\n  ${getBaseUrl()}/api/v1/stores</pre>`;

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('◀️ К документации', 'docs_menu')]])
  });
});

masterBot.action('docs_del_bot', async (ctx) => {
  await ctx.answerCbQuery();
  const text =
    `🗑 <b>API: Остановка и удаление бота</b>\n\n` +
    `<code>DELETE /api/v1/stores/{storeId}</code>\n\n` +
    `<b>Пример запроса cURL:</b>\n` +
    `<pre>curl -X DELETE ${getBaseUrl()}/api/v1/stores/shop_xxxx \\\n  -H "Authorization: Bearer sk_live_..."</pre>`;

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('◀️ К документации', 'docs_menu')]])
  });
});

// Configure Base URL
masterBot.action('set_base_url', async (ctx) => {
  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, { step: 'awaiting_base_url' });
  const text =
    `🌐 <b>Настройка постоянного Base URL</b>\n\n` +
    `Текущий: <code>${getBaseUrl()}</code>\n\n` +
    `Отправьте новый домен или адрес хостинга (например: <code>https://mybot.bothost.ru</code> или <code>https://myshop.onrender.com</code>):`;

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'back_master')]])
  });
});

// Master Text Handler
masterBot.on('text', async (ctx) => {
  const st = userStates.get(ctx.from.id);
  if (!st) return;

  if (st.step === 'awaiting_base_url') {
    userStates.delete(ctx.from.id);
    let url = ctx.message.text.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    db.setPlatformSetting('custom_base_url', url);
    return ctx.reply(`✅ Base URL успешно сохранён:\n<code>${url}</code>`, { parse_mode: 'HTML' });
  }

  if (st.step === 'awaiting_bot_token') {
    const token = ctx.message.text.trim();
    st.botToken = token;

    // Test token validity via getMe
    try {
      const testBot = new Telegraf(token);
      const me = await testBot.telegram.getMe();
      st.botUsername = me.username;
      st.botName = me.first_name;
      st.step = 'awaiting_admin_id';

      await ctx.reply(
        `✅ Бот найден: <b>@${me.username}</b> (${me.first_name})\n\n` +
        `<b>Шаг 2 из 2:</b>\n` +
        `Введите Telegram ID администратора этого магазина:\n(Ваш ID: <code>${ctx.from.id}</code>)`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback(`Использовать мой ID (${ctx.from.id})`, 'use_my_id')]])
        }
      );
    } catch (e) {
      return ctx.reply(`❌ Невалидный токен бота: ${e.message}\nПопробуйте отправить корректный токен от @BotFather:`);
    }
    return;
  }

  if (st.step === 'awaiting_admin_id') {
    const adminId = parseInt(ctx.message.text.trim());
    if (isNaN(adminId)) return ctx.reply('Введите корректный числовой Telegram ID:');
    await completeStoreCreation(ctx, st, adminId);
  }
});

masterBot.action('use_my_id', async (ctx) => {
  await ctx.answerCbQuery();
  const st = userStates.get(ctx.from.id);
  if (!st || st.step !== 'awaiting_admin_id') return;
  await completeStoreCreation(ctx, st, ctx.from.id);
});

async function completeStoreCreation(ctx, st, adminId) {
  try {
    userStates.delete(ctx.from.id);
    const storeId = 'shop_' + crypto.randomBytes(4).toString('hex');
    const storeName = st.botName || 'Магазин';

    const newStore = db.createStore(storeId, ctx.from.id, st.botToken, adminId, st.botUsername, storeName);

    // Generate initial developer API key
    const apiKey = 'sk_live_' + crypto.randomBytes(20).toString('hex');
    db.createApiKey(apiKey, ctx.from.id, `Ключ для ${storeName}`);

    // Start store bot
    const started = await startStoreBot(newStore, getBaseUrl);
    const appUrl = getPublicMiniAppUrl(storeId, getBaseUrl());

    const text =
      `🎉 <b>Бот-магазин успешно создан и ${started ? 'запущен 🟢' : 'сохранён ⚪️'}!</b>\n\n` +
      `🏷 Название: <b>${storeName}</b>\n` +
      `🤖 Бот: @${st.botUsername}\n` +
      `🆔 ID магазина: <code>${storeId}</code>\n` +
      `👑 Администратор: <code>${adminId}</code>\n\n` +
      `⚡ <b>Ссылка на персональную Mini App:</b>\n<code>${appUrl}</code>\n\n` +
      `🔑 <b>Ваш API токен разработчика:</b>\n<code>${apiKey}</code>\n\n` +
      `📚 <b>Документация API:</b>\n${VERCEL_DOCS_URL}`;

    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [{ text: '📱 Открыть бота магазина', url: `https://t.me/${st.botUsername}` }],
        [{ text: '⚙️ Управление магазином', callback_data: `manage_store_${storeId}` }],
        [{ text: '◀️ В главное меню', callback_data: 'back_master' }]
      ])
    });
  } catch (err) {
    console.error('[CreateStore Error]:', err);
    await ctx.reply(`❌ Ошибка при создании магазина: ${err.message}`);
  }
}

// Function to start server and all active stores (called when you give the command)
async function startPlatform() {
  const server = createServer(getBaseUrl);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Platform] HTTP Server listening on port ${PORT}`);
  });

  // Start background auto-tunnel if no custom domain configured
  startTunnelService();

  // Launch Master Bot in background
  masterBot.launch({ dropPendingUpdates: true })
    .then(() => console.log('[Platform] Master Bot successfully started.'))
    .catch(err => console.error('[Platform] Master Bot launch error:', err.message));

  // Restore and launch all previously created active stores
  const activeStores = db.getAllActiveStores();
  console.log(`[Platform] Restoring ${activeStores.length} store bots...`);
  for (const s of activeStores) {
    await startStoreBot(s, getBaseUrl);
  }
}

// Export for manual or future execution
module.exports = {
  startPlatform,
  masterBot
};

// If run directly via "node index.js"
if (require.main === module) {
  startPlatform().catch(err => {
    console.error('Fatal platform error:', err);
  });
}
