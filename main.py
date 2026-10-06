import os
import re
import sys
import time
import subprocess
import threading
import secrets
import telebot
from telebot import types
import db
import bot_manager
from server import create_app

# Master Bot Token
MASTER_BOT_TOKEN = '8639107571:AAFiqtvgHY4PaknT7pisSS4jipfdw6RVgU4'
PORT = int(os.environ.get('PORT', 3001))
VERCEL_DOCS_URL = 'https://bot-factory-docs.vercel.app'

def get_base_url():
    custom = db.get_platform_setting('custom_base_url')
    if custom:
        return custom.rstrip('/')
    if os.environ.get('BASE_URL'):
        return os.environ['BASE_URL'].rstrip('/')
    return 'https://bot-factory-platform.vercel.app'

# Auto Tunnel Service (Pinggy HTTPS with auto-reconnect)
tunnel_process = None

def start_tunnel_service():
    global tunnel_process
    def run_tunnel():
        global tunnel_process
        while True:
            try:
                print(f"[Tunnel] Launching HTTPS public tunnel on port {PORT}...")
                tunnel_process = subprocess.Popen([
                    'ssh',
                    '-o', 'StrictHostKeyChecking=no',
                    '-o', 'ServerAliveInterval=30',
                    '-p', '443',
                    f'-R0:localhost:{PORT}',
                    'a.pinggy.io'
                ], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

                for line in tunnel_process.stdout:
                    match = re.search(r'https://[a-zA-Z0-9-]+\.(?:free\.pinggy\.net|run\.pinggy-free\.link)', line)
                    if match:
                        public_url = match.group(0)
                        current_perm = db.get_platform_setting('permanent_base_url')
                        if not current_perm:
                            db.set_platform_setting('permanent_base_url', public_url)
                            print(f"\n======================================================")
                            print(f"[Platform] Permanent Free Base URL locked: {public_url}")
                            print(f"======================================================\n")
                        db.set_platform_setting('tunnel_public_url', public_url)

                tunnel_process.wait()
                print(f"[Tunnel] Exited with code {tunnel_process.returncode}. Reconnecting in 5s...")
            except Exception as e:
                print(f"[Tunnel Error]: {e}")
            time.sleep(5)

    t = threading.Thread(target=run_tunnel, daemon=True)
    t.start()

master_bot = telebot.TeleBot(MASTER_BOT_TOKEN, threaded=True)
user_states = {}

def get_master_keyboard():
    markup = types.InlineKeyboardMarkup()
    markup.row(types.InlineKeyboardButton('➕ Создать магазин', callback_data='create_store'))
    markup.row(
        types.InlineKeyboardButton('📱 Мои магазины', callback_data='my_stores'),
        types.InlineKeyboardButton('🔑 API для разработчиков', callback_data='dev_api')
    )
    markup.row(
        types.InlineKeyboardButton('📚 Документация API', callback_data='docs_menu'),
        types.InlineKeyboardButton('🌐 Настроить Base URL', callback_data='set_base_url')
    )
    return markup

@master_bot.message_handler(commands=['start'])
def handle_master_start(message):
    user_id = message.from_user.id
    db.get_platform_user(user_id, message.from_user.username or '', message.from_user.first_name or '')
    user_states.pop(user_id, None)

    name = message.from_user.first_name or 'Разработчик'
    text = (
        f"🏭 <b>Платформа-конструктор ботов-магазинов</b>\n\n"
        f"Привет, <b>{name}</b>!\n"
        f"Здесь вы можете за пару секунд создать собственного бота-магазина со встроенной Mini App и получить API токен для разработчиков.\n\n"
        f"🌐 <b>Текущий Base URL:</b>\n<code>{get_base_url()}</code>\n\n"
        f"Выберите действие:"
    )
    master_bot.send_message(message.chat.id, text, parse_mode='HTML', reply_markup=get_master_keyboard())

@master_bot.callback_query_handler(func=lambda call: True)
def handle_master_callbacks(call):
    user_id = call.from_user.id
    data = call.data

    if data == 'back_master':
        master_bot.answer_callback_query(call.id)
        user_states.pop(user_id, None)
        master_bot.send_message(call.message.chat.id, '📋 Главное меню платформы:', reply_markup=get_master_keyboard())
        return

    if data == 'create_store':
        master_bot.answer_callback_query(call.id)
        user_states[user_id] = {'step': 'awaiting_bot_token'}
        text = (
            f"🛠 <b>Создание нового бота-магазина</b>\n\n"
            f"<b>Шаг 1 из 2:</b>\n"
            f"Отправьте токен бота, полученный от @BotFather:"
        )
        markup = types.InlineKeyboardMarkup()
        markup.row(types.InlineKeyboardButton('❌ Отмена', callback_data='back_master'))
        master_bot.send_message(call.message.chat.id, text, parse_mode='HTML', reply_markup=markup)
        return

    if data == 'my_stores':
        master_bot.answer_callback_query(call.id)
        stores = db.get_stores_by_owner(user_id)
        if not stores:
            markup = types.InlineKeyboardMarkup()
            markup.row(types.InlineKeyboardButton('➕ Создать магазин', callback_data='create_store'))
            markup.row(types.InlineKeyboardButton('◀️ Назад', callback_data='back_master'))
            master_bot.send_message(call.message.chat.id, 'У вас пока нет созданных магазинов.', reply_markup=markup)
            return

        markup = types.InlineKeyboardMarkup()
        for s in stores:
            uname = s.get('bot_username') or s['id']
            markup.row(types.InlineKeyboardButton(f"🛍 {s['store_name']} (@{uname})", callback_data=f"manage_store_{s['id']}"))
        markup.row(types.InlineKeyboardButton('◀️ В меню', callback_data='back_master'))
        master_bot.send_message(call.message.chat.id, '📱 <b>Ваши магазины:</b>', parse_mode='HTML', reply_markup=markup)
        return

    if data.startswith('manage_store_'):
        master_bot.answer_callback_query(call.id)
        store_id = data.replace('manage_store_', '')
        s = db.get_store(store_id)
        if not s or s['owner_id'] != user_id:
            master_bot.send_message(call.message.chat.id, 'Магазин не найден.')
            return

        stats = db.get_store_stats(store_id)
        app_url = bot_manager.get_public_miniapp_url(store_id, get_base_url())

        status_text = '🟢 Работает' if s.get('status') == 'active' else '🔴 Остановлен'
        text = (
            f"🛍 <b>Управление магазином: {s['store_name']}</b>\n\n"
            f"• Бот: @{s.get('bot_username') or '—'}\n"
            f"• Статус: <b>{status_text}</b>\n"
            f"• ID админа магазина: <code>{s['admin_id']}</code>\n"
            f"• Покупателей: <b>{stats['users']}</b>\n"
            f"• Заказов: <b>{stats['ordersCount']}</b> (на <b>{stats['ordersVolume']} ₽</b>)\n\n"
            f"⚡ <b>Ссылка на Mini App магазина:</b>\n<code>{app_url}</code>"
        )
        markup = types.InlineKeyboardMarkup()
        toggle_text = '⏸ Остановить' if s.get('status') == 'active' else '▶️ Запустить'
        markup.row(
            types.InlineKeyboardButton(toggle_text, callback_data=f"toggle_store_{s['id']}"),
            types.InlineKeyboardButton('🗑 Удалить', callback_data=f"del_store_{s['id']}")
        )
        markup.row(types.InlineKeyboardButton('🔑 Создать API токен', callback_data=f"create_api_{s['id']}"))
        markup.row(types.InlineKeyboardButton('◀️ К списку магазинов', callback_data='my_stores'))
        master_bot.send_message(call.message.chat.id, text, parse_mode='HTML', reply_markup=markup)
        return

    if data.startswith('toggle_store_'):
        master_bot.answer_callback_query(call.id)
        store_id = data.replace('toggle_store_', '')
        s = db.get_store(store_id)
        if not s or s['owner_id'] != user_id:
            return

        if s.get('status') == 'active':
            bot_manager.stop_store_bot(store_id)
            db.update_store_status(store_id, 'stopped')
            master_bot.send_message(call.message.chat.id, f"🔴 Магазин «{s['store_name']}» остановлен.")
        else:
            db.update_store_status(store_id, 'active')
            started = bot_manager.start_store_bot(db.get_store(store_id), get_base_url)
            msg = f"🟢 Магазин «{s['store_name']}» успешно запущен!" if started else "❌ Ошибка запуска. Проверьте токен бота."
            master_bot.send_message(call.message.chat.id, msg)
        return

    if data.startswith('del_store_'):
        master_bot.answer_callback_query(call.id)
        store_id = data.replace('del_store_', '')
        s = db.get_store(store_id)
        if not s or s['owner_id'] != user_id:
            return

        bot_manager.stop_store_bot(store_id)
        db.delete_store(store_id)
        master_bot.send_message(call.message.chat.id, f"🗑 Магазин «{s['store_name']}» полностью удалён.")
        return

    if data.startswith('create_api_') or data == 'dev_api':
        master_bot.answer_callback_query(call.id)
        keys = db.get_api_keys(user_id)
        text = "🔑 <b>API для разработчиков (создание и управление ботами через код)</b>\n\n"
        if not keys:
            text += "У вас пока нет активных API ключей.\nНажмите кнопку ниже, чтобы сгенерировать токен доступа."
        else:
            text += "Ваши API токены:\n\n"
            for idx, k in enumerate(keys):
                text += f"<b>{idx + 1}. {k['name']}</b>\n<code>{k['key']}</code>\n\n"

        markup = types.InlineKeyboardMarkup()
        markup.row(types.InlineKeyboardButton('➕ Сгенерировать новый API ключ', callback_data='create_dev_key'))
        markup.row(types.InlineKeyboardButton('📚 Документация в боте', callback_data='docs_menu'))
        markup.row(types.InlineKeyboardButton('🌐 Веб-документация (Vercel)', url=VERCEL_DOCS_URL))
        markup.row(types.InlineKeyboardButton('◀️ В меню', callback_data='back_master'))
        master_bot.send_message(call.message.chat.id, text, parse_mode='HTML', reply_markup=markup)
        return

    if data == 'create_dev_key':
        master_bot.answer_callback_query(call.id)
        raw_key = f"sk_live_{secrets.token_hex(20)}"
        db.create_api_key(raw_key, user_id, f"Developer Key #{str(int(time.time()))[-4:]}")
        text = (
            f"✅ <b>Новый API ключ успешно выпущен!</b>\n\n"
            f"Токен:\n<code>{raw_key}</code>\n\n"
            f"Используйте его в заголовке:\n<code>Authorization: Bearer {raw_key}</code>\n\n"
            f"С его помощью вы можете создавать ботов программно через <code>POST /api/v1/stores</code>."
        )
        markup = types.InlineKeyboardMarkup()
        markup.row(types.InlineKeyboardButton('📚 Открыть документацию', callback_data='docs_menu'))
        markup.row(types.InlineKeyboardButton('◀️ К списку ключей', callback_data='dev_api'))
        master_bot.send_message(call.message.chat.id, text, parse_mode='HTML', reply_markup=markup)
        return

    if data == 'docs_menu':
        master_bot.answer_callback_query(call.id)
        base_url = get_base_url()
        text = (
            f"📚 <b>Документация REST API для создания ботов и управления</b>\n\n"
            f"API позволяет программно создавать ботов-магазинов, запускать их и управлять ими из любого приложения или скрипта.\n\n"
            f"🌐 <b>Base URL:</b>\n<code>{base_url}</code>\n\n"
            f"🔑 <b>Авторизация:</b>\nПередавайте токен в заголовке:\n"
            f"<code>Authorization: Bearer sk_live_...</code>\nили\n"
            f"<code>X-API-Key: sk_live_...</code>\n\n"
            f"<b>Доступные методы API:</b>"
        )
        markup = types.InlineKeyboardMarkup()
        markup.row(
            types.InlineKeyboardButton('🤖 Создать бота (POST)', callback_data='docs_create_bot'),
            types.InlineKeyboardButton('📱 Список ботов (GET)', callback_data='docs_list_bots')
        )
        markup.row(types.InlineKeyboardButton('🗑 Удалить бота (DELETE)', callback_data='docs_del_bot'))
        markup.row(types.InlineKeyboardButton('🌐 Открыть веб-версию (Vercel)', url=VERCEL_DOCS_URL))
        markup.row(types.InlineKeyboardButton('◀️ В главное меню', callback_data='back_master'))
        master_bot.send_message(call.message.chat.id, text, parse_mode='HTML', reply_markup=markup)
        return

    if data == 'docs_create_bot':
        master_bot.answer_callback_query(call.id)
        text = (
            f"🤖 <b>API: Создание и запуск бота-магазина</b>\n\n"
            f"Создаёт и мгновенно запускает нового Telegram-бота с привязанной Mini App.\n\n"
            f"<code>POST /api/v1/stores</code>\n\n"
            f"<b>Заголовки:</b>\n"
            f"• <code>Authorization: Bearer sk_live_...</code>\n"
            f"• <code>Content-Type: application/json</code>\n\n"
            f"<b>Тело запроса (JSON):</b>\n"
            f"<pre>{{\n  \"botToken\": \"123456:ABC-DEF...\",\n  \"adminId\": 8282599467,\n  \"storeName\": \"Мой Магазин\"\n}}</pre>\n\n"
            f"<b>Пример ответа (JSON):</b>\n"
            f"<pre>{{\n  \"ok\": true,\n  \"storeId\": \"shop_a1b2\",\n  \"botUsername\": \"my_shop_bot\",\n  \"storeName\": \"Мой Магазин\",\n  \"miniAppUrl\": \"{get_base_url()}/app?shop=shop_a1b2\"\n}}</pre>"
        )
        markup = types.InlineKeyboardMarkup()
        markup.row(types.InlineKeyboardButton('◀️ К документации', callback_data='docs_menu'))
        master_bot.send_message(call.message.chat.id, text, parse_mode='HTML', reply_markup=markup)
        return

    if data == 'docs_list_bots':
        master_bot.answer_callback_query(call.id)
        text = (
            f"📱 <b>API: Получение списка ваших ботов</b>\n\n"
            f"Возвращает все магазины, созданные через ваш аккаунт/токен.\n\n"
            f"<code>GET /api/v1/stores</code>\n\n"
            f"<b>Пример запроса cURL:</b>\n"
            f"<pre>curl -H \"Authorization: Bearer sk_live_...\" \\\n  {get_base_url()}/api/v1/stores</pre>"
        )
        markup = types.InlineKeyboardMarkup()
        markup.row(types.InlineKeyboardButton('◀️ К документации', callback_data='docs_menu'))
        master_bot.send_message(call.message.chat.id, text, parse_mode='HTML', reply_markup=markup)
        return

    if data == 'docs_del_bot':
        master_bot.answer_callback_query(call.id)
        text = (
            f"🗑 <b>API: Остановка и удаление бота</b>\n\n"
            f"<code>DELETE /api/v1/stores/{{storeId}}</code>\n\n"
            f"<b>Пример запроса cURL:</b>\n"
            f"<pre>curl -X DELETE {get_base_url()}/api/v1/stores/shop_xxxx \\\n  -H \"Authorization: Bearer sk_live_...\"</pre>"
        )
        markup = types.InlineKeyboardMarkup()
        markup.row(types.InlineKeyboardButton('◀️ К документации', callback_data='docs_menu'))
        master_bot.send_message(call.message.chat.id, text, parse_mode='HTML', reply_markup=markup)
        return

    if data == 'set_base_url':
        master_bot.answer_callback_query(call.id)
        user_states[user_id] = {'step': 'awaiting_base_url'}
        text = (
            f"🌐 <b>Настройка постоянного Base URL</b>\n\n"
            f"Текущий: <code>{get_base_url()}</code>\n\n"
            f"Отправьте новый домен или адрес хостинга (например: <code>https://mybot.bothost.ru</code> или <code>https://myshop.onrender.com</code>):"
        )
        markup = types.InlineKeyboardMarkup()
        markup.row(types.InlineKeyboardButton('❌ Отмена', callback_data='back_master'))
        master_bot.send_message(call.message.chat.id, text, parse_mode='HTML', reply_markup=markup)
        return

    if data == 'use_my_id':
        master_bot.answer_callback_query(call.id)
        st = user_states.get(user_id)
        if not st or st.get('step') != 'awaiting_admin_id':
            return
        complete_store_creation(call.message.chat.id, user_id, st, user_id)
        return

@master_bot.message_handler(content_types=['text'])
def handle_master_text(message):
    user_id = message.from_user.id
    st = user_states.get(user_id)
    if not st:
        return

    step = st.get('step')

    if step == 'awaiting_base_url':
        user_states.pop(user_id, None)
        url = message.text.strip()
        if not url.startswith('http://') and not url.startswith('https://'):
            url = 'https://' + url
        db.set_platform_setting('custom_base_url', url)
        master_bot.send_message(message.chat.id, f"✅ Base URL успешно сохранён:\n<code>{url}</code>", parse_mode='HTML')
        return

    if step == 'awaiting_bot_token':
        token = message.text.strip()
        st['botToken'] = token

        try:
            test_bot = telebot.TeleBot(token, threaded=False)
            me = test_bot.get_me()
            st['botUsername'] = me.username
            st['botName'] = me.first_name
            st['step'] = 'awaiting_admin_id'

            markup = types.InlineKeyboardMarkup()
            markup.row(types.InlineKeyboardButton(f"Использовать мой ID ({user_id})", callback_data='use_my_id'))
            text = (
                f"✅ Бот найден: <b>@{me.username}</b> ({me.first_name})\n\n"
                f"<b>Шаг 2 из 2:</b>\n"
                f"Введите Telegram ID администратора этого магазина:\n(Ваш ID: <code>{user_id}</code>)"
            )
            master_bot.send_message(message.chat.id, text, parse_mode='HTML', reply_markup=markup)
        except Exception as e:
            master_bot.send_message(message.chat.id, f"❌ Невалидный токен бота: {e}\nПопробуйте отправить корректный токен от @BotFather:")
        return

    if step == 'awaiting_admin_id':
        try:
            admin_id = int(message.text.strip())
            complete_store_creation(message.chat.id, user_id, st, admin_id)
        except ValueError:
            master_bot.send_message(message.chat.id, 'Введите корректный числовой Telegram ID:')
        return

def complete_store_creation(chat_id, user_id, st, admin_id):
    try:
        user_states.pop(user_id, None)
        store_id = f"shop_{secrets.token_hex(4)}"
        store_name = st.get('botName') or 'Магазин'

        new_store = db.create_store(store_id, user_id, st['botToken'], admin_id, st.get('botUsername'), store_name)

        api_key = f"sk_live_{secrets.token_hex(20)}"
        db.create_api_key(api_key, user_id, f"Ключ для {store_name}")

        started = bot_manager.start_store_bot(new_store, get_base_url)
        app_url = bot_manager.get_public_miniapp_url(store_id, get_base_url())

        status_str = 'запущен 🟢' if started else 'сохранён ⚪️'
        text = (
            f"🎉 <b>Бот-магазин успешно создан и {status_str}!</b>\n\n"
            f"🏷 Название: <b>{store_name}</b>\n"
            f"🤖 Бот: @{st.get('botUsername')}\n"
            f"🆔 ID магазина: <code>{store_id}</code>\n"
            f"👑 Администратор: <code>{admin_id}</code>\n\n"
            f"⚡ <b>Ссылка на персональную Mini App:</b>\n<code>{app_url}</code>\n\n"
            f"🔑 <b>Ваш API токен разработчика:</b>\n<code>{api_key}</code>\n\n"
            f"📚 <b>Документация API:</b>\n{VERCEL_DOCS_URL}"
        )
        markup = types.InlineKeyboardMarkup()
        if st.get('botUsername'):
            markup.row(types.InlineKeyboardButton('📱 Открыть бота магазина', url=f"https://t.me/{st['botUsername']}"))
        markup.row(types.InlineKeyboardButton('⚙️ Управление магазином', callback_data=f"manage_store_{store_id}"))
        markup.row(types.InlineKeyboardButton('◀️ В главное меню', callback_data='back_master'))

        master_bot.send_message(chat_id, text, parse_mode='HTML', reply_markup=markup)
    except Exception as err:
        print(f"[CreateStore Error]: {err}")
        master_bot.send_message(chat_id, f"❌ Ошибка при создании магазина: {err}")

def start_platform():
    app = create_app(get_base_url)

    # 1. Start HTTP server in thread
    def run_server():
        print(f"[Platform] HTTP Server listening on port {PORT}...")
        app.run(host='0.0.0.0', port=PORT, debug=False, use_reloader=False)

    server_thread = threading.Thread(target=run_server, daemon=True)
    server_thread.start()

    # 2. Start SSH tunnel in thread
    start_tunnel_service()

    # 3. Restore all active store bots
    active_stores = db.get_all_active_stores()
    print(f"[Platform] Restoring {len(active_stores)} store bots...")
    for s in active_stores:
        bot_manager.start_store_bot(s, get_base_url)

    # 4. Run Master bot in current thread (blocking polling)
    print('[Platform] Starting Master Bot polling...')
    try:
        master_bot.infinity_polling(timeout=20, long_polling_timeout=20)
    except Exception as e:
        print(f"[Platform] Master Bot stopped: {e}")

if __name__ == '__main__':
    start_platform()
