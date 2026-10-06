import json
import threading
import requests
import telebot
from telebot import types
import db

# Map: store_id -> telebot.TeleBot instance
active_bots = {}
active_threads = {}
user_states = {}  # key: f"{store_id}_{user_id}" -> dict

def get_public_miniapp_url(store_id: str, base_url: str) -> str:
    # Use direct local/tunnel URL or Vercel app
    if base_url and 'http' in base_url:
        return f"{base_url.rstrip('/')}/app?shop={store_id}"
    return f"https://bot-factory-miniapp.vercel.app/?shop={store_id}"

def create_crypto_invoice(store: dict, amount_rub: float, method: str) -> dict:
    rate = float(store.get('usdt_rate') or 95)
    amount_usdt = max(0.1, round(amount_rub / rate, 2))

    if method == 'cryptobot':
        token = store.get('cryptobot_token')
        if not token:
            raise Exception('CryptoBot токен не настроен владельцем магазина')
        res = requests.post(
            'https://pay.crypt.bot/api/createInvoice',
            headers={'Crypto-Pay-API-Token': token, 'Content-Type': 'application/json'},
            json={
                'asset': 'USDT',
                'amount': str(amount_usdt),
                'description': f'Пополнение баланса ({amount_rub} RUB)',
                'expires_in': 3600
            },
            timeout=10
        )
        data = res.json()
        if not data.get('ok'):
            err_msg = data.get('error', {}).get('name') if isinstance(data.get('error'), dict) else 'Ошибка создания счета CryptoBot'
            raise Exception(err_msg)
        return {
            'invoiceId': str(data['result']['invoice_id']),
            'payUrl': data['result'].get('bot_invoice_url') or data['result'].get('pay_url'),
            'amountUsdt': amount_usdt
        }

    if method == 'xrocket':
        token = store.get('xrocket_token')
        if not token:
            raise Exception('xRocket токен не настроен владельцем магазина')
        res = requests.post(
            'https://pay.xrocket.tg/tg-invoices',
            headers={'Rocket-Pay-Key': token, 'Content-Type': 'application/json'},
            json={
                'amount': amount_usdt,
                'currency': 'USDT',
                'description': f'Пополнение баланса ({amount_rub} RUB)',
                'numPayments': 1
            },
            timeout=10
        )
        data = res.json()
        if not data.get('success'):
            raise Exception(data.get('message') or 'Ошибка создания счета xRocket')
        return {
            'invoiceId': str(data['data']['id']),
            'payUrl': data['data']['link'],
            'amountUsdt': amount_usdt
        }

    raise Exception('Неизвестный метод оплаты')

def get_menu_keyboard(store: dict, user_id: int, base_url: str):
    markup = types.InlineKeyboardMarkup(row_width=2)
    app_url = get_public_miniapp_url(store['id'], base_url)

    btn_app = types.InlineKeyboardButton('⚡ Открыть магазин (Mini App)', web_app=types.WebAppInfo(url=app_url))
    markup.row(btn_app)

    btn_cat = types.InlineKeyboardButton('🛍 Каталог товаров', callback_data='catalog')
    btn_prof = types.InlineKeyboardButton('👤 Мой профиль', callback_data='profile')
    markup.row(btn_cat, btn_prof)

    btn_dep = types.InlineKeyboardButton('💳 Пополнить баланс', callback_data='deposit')
    btn_ord = types.InlineKeyboardButton('📦 Мои покупки', callback_data='purchases')
    markup.row(btn_dep, btn_ord)

    if store.get('support_contact'):
        markup.row(types.InlineKeyboardButton('💬 Поддержка', callback_data='support'))

    if user_id == int(store['admin_id']):
        markup.row(types.InlineKeyboardButton('⚙️ Панель управления (Admin)', callback_data='admin_panel'))

    return markup

def build_store_bot(store: dict, get_base_url_fn) -> telebot.TeleBot:
    bot = telebot.TeleBot(store['bot_token'], threaded=False)
    store_id = store['id']

    @bot.message_handler(commands=['start'])
    def handle_start(message):
        try:
            user = db.get_store_user(store_id, message.from_user.id, message.from_user.username or '', message.from_user.first_name or '')
            text = (
                f"🛍 <b>{store['store_name']}</b>\n\n"
                f"Приветствуем, <b>{message.from_user.first_name or 'клиент'}</b>!\n"
                f"Автоматический магазин цифровых товаров.\n\n"
                f"🆔 Ваш ID: <code>{user['id']}</code>\n"
                f"💰 Баланс: <b>{user['balance']:.2f} ₽</b>\n\n"
                f"Выберите действие в меню или откройте Web App:"
            )
            bot.send_message(
                message.chat.id,
                text,
                parse_mode='HTML',
                reply_markup=get_menu_keyboard(store, message.from_user.id, get_base_url_fn())
            )
        except Exception as e:
            print(f"[StoreBot {store_id} start error]: {e}")

    @bot.callback_query_handler(func=lambda call: True)
    def handle_callbacks(call):
        data = call.data
        user_id = call.from_user.id

        if data == 'back_main':
            bot.answer_callback_query(call.id)
            user_states.pop(f"{store_id}_{user_id}", None)
            bot.send_message(
                call.message.chat.id,
                '📋 Главное меню:',
                reply_markup=get_menu_keyboard(store, user_id, get_base_url_fn())
            )
            return

        if data == 'profile':
            bot.answer_callback_query(call.id)
            user = db.get_store_user(store_id, user_id)
            purchases = db.get_user_purchases(store_id, user_id)
            text = (
                f"👤 <b>Личный кабинет</b>\n\n"
                f"• ID: <code>{user['id']}</code>\n"
                f"• Баланс: <b>{user['balance']:.2f} ₽</b>\n"
                f"• Покупок: <b>{len(purchases)} шт.</b>"
            )
            markup = types.InlineKeyboardMarkup()
            markup.row(types.InlineKeyboardButton('💳 Пополнить баланс', callback_data='deposit'))
            markup.row(types.InlineKeyboardButton('📦 Мои покупки', callback_data='purchases'))
            markup.row(types.InlineKeyboardButton('◀️ Назад', callback_data='back_main'))
            bot.send_message(call.message.chat.id, text, parse_mode='HTML', reply_markup=markup)
            return

        if data == 'purchases':
            bot.answer_callback_query(call.id)
            orders = db.get_user_purchases(store_id, user_id)
            if not orders:
                bot.send_message(call.message.chat.id, '📦 У вас пока нет оформленных заказов.')
                return

            text = f"📦 <b>Ваши покупки (всего: {len(orders)}):</b>\n\n"
            for idx, o in enumerate(orders[:5]):
                text += f"<b>{idx + 1}. {o['product_title']}</b> — {o['price']} ₽\n📅 {o['created_at']}\n🔑 <code>{o['delivered_content']}</code>\n\n"

            markup = types.InlineKeyboardMarkup()
            rev_enabled = store.get('reviews_enabled', 1) != 0
            for idx, o in enumerate(orders[:5]):
                if rev_enabled:
                    markup.row(types.InlineKeyboardButton(f"⭐️ Оставить отзыв о #{idx + 1}", callback_data=f"rev_{o['product_id']}"))

            markup.row(types.InlineKeyboardButton('◀️ В меню', callback_data='back_main'))
            bot.send_message(call.message.chat.id, text, parse_mode='HTML', reply_markup=markup)
            return

        if data == 'catalog':
            bot.answer_callback_query(call.id)
            cats = db.get_categories(store_id)
            if not cats:
                bot.send_message(call.message.chat.id, '🛍 Каталог пока пуст.')
                return
            markup = types.InlineKeyboardMarkup()
            for c in cats:
                markup.row(types.InlineKeyboardButton(c['title'], callback_data=f"cat_{c['id']}"))
            markup.row(types.InlineKeyboardButton('◀️ Назад', callback_data='back_main'))
            bot.send_message(call.message.chat.id, '📂 <b>Выберите категорию:</b>', parse_mode='HTML', reply_markup=markup)
            return

        if data.startswith('cat_'):
            bot.answer_callback_query(call.id)
            cat_id = int(data.split('_')[1])
            prods = db.get_products(store_id, cat_id)
            if not prods:
                bot.send_message(call.message.chat.id, 'В этой категории пока нет товаров.')
                return
            markup = types.InlineKeyboardMarkup()
            for p in prods:
                try:
                    pool = json.loads(p.get('content_pool') or '[]')
                    stock = len(pool)
                except Exception:
                    stock = 0
                markup.row(types.InlineKeyboardButton(f"{p['title']} — {p['price']} ₽ ({stock} шт.)", callback_data=f"prod_{p['id']}"))
            markup.row(types.InlineKeyboardButton('◀️ К категориям', callback_data='catalog'))
            bot.send_message(call.message.chat.id, '🛍 <b>Товары:</b>', parse_mode='HTML', reply_markup=markup)
            return

        if data.startswith('prod_'):
            bot.answer_callback_query(call.id)
            prod_id = int(data.split('_')[1])
            p = db.get_product(store_id, prod_id)
            if not p:
                bot.send_message(call.message.chat.id, 'Товар не найден.')
                return

            try:
                pool = json.loads(p.get('content_pool') or '[]')
                stock = len(pool)
            except Exception:
                stock = 0

            rev_enabled = store.get('reviews_enabled', 1) != 0
            rating_data = db.get_product_rating(store_id, prod_id)
            rating_str = f"★ {rating_data['average']} ({rating_data['count']} отзывов)" if rating_data['count'] > 0 else 'Отзывов пока нет'

            text = (
                f"🏷 <b>{p['title']}</b>\n\n"
                f"📝 {p.get('description') or 'Описание отсутствует.'}\n\n"
            )
            if rev_enabled:
                text += f"⭐ <b>Рейтинг:</b> {rating_str}\n"
            text += f"💰 <b>Цена:</b> {p['price']} ₽\n📦 <b>В наличии:</b> {stock} шт."

            markup = types.InlineKeyboardMarkup()
            if stock > 0:
                markup.row(types.InlineKeyboardButton('🛒 Купить за баланс', callback_data=f"buy_{p['id']}"))
            else:
                markup.row(types.InlineKeyboardButton('❌ Нет в наличии', callback_data='noop'))

            if rev_enabled and db.has_user_purchased_product(store_id, user_id, p['id']):
                markup.row(types.InlineKeyboardButton('⭐️ Оставить отзыв', callback_data=f"rev_{p['id']}"))

            markup.row(types.InlineKeyboardButton('◀️ Назад', callback_data='catalog'))
            bot.send_message(call.message.chat.id, text, parse_mode='HTML', reply_markup=markup)
            return

        if data.startswith('buy_'):
            bot.answer_callback_query(call.id)
            prod_id = int(data.split('_')[1])
            p = db.get_product(store_id, prod_id)
            user = db.get_store_user(store_id, user_id)
            if not p:
                bot.send_message(call.message.chat.id, 'Товар не найден.')
                return

            try:
                pool = json.loads(p.get('content_pool') or '[]')
            except Exception:
                pool = []

            if not pool:
                bot.send_message(call.message.chat.id, '❌ К сожалению, товар закончился.')
                return

            if user['balance'] < p['price']:
                markup = types.InlineKeyboardMarkup()
                markup.row(types.InlineKeyboardButton('💳 Пополнить баланс', callback_data='deposit'))
                bot.send_message(
                    call.message.chat.id,
                    f"❌ <b>Недостаточно средств!</b>\nЦена: {p['price']} ₽\nВаш баланс: {user['balance']:.2f} ₽",
                    parse_mode='HTML',
                    reply_markup=markup
                )
                return

            delivered = pool.pop(0)
            db.update_store_user_balance(store_id, user_id, -p['price'])
            db.update_product_pool(store_id, prod_id, pool)
            db.add_purchase(store_id, user_id, prod_id, p['title'], p['price'], delivered)

            markup = types.InlineKeyboardMarkup()
            if store.get('reviews_enabled', 1) != 0:
                markup.row(types.InlineKeyboardButton('⭐️ Оставить отзыв о товаре', callback_data=f"rev_{prod_id}"))
            markup.row(types.InlineKeyboardButton('◀️ В меню', callback_data='back_main'))

            bot.send_message(
                call.message.chat.id,
                f"✅ <b>Покупка совершена!</b>\n\n"
                f"🏷 <b>Товар:</b> {p['title']}\n"
                f"💰 <b>Списано:</b> {p['price']} ₽\n\n"
                f"🔑 <b>Ваш товар:</b>\n<code>{delivered}</code>",
                parse_mode='HTML',
                reply_markup=markup
            )
            return

        if data.startswith('rev_'):
            bot.answer_callback_query(call.id)
            if store.get('reviews_enabled', 1) == 0:
                bot.send_message(call.message.chat.id, '❌ Система отзывов отключена администратором.')
                return
            prod_id = int(data.split('_')[1])
            if not db.has_user_purchased_product(store_id, user_id, prod_id):
                bot.send_message(call.message.chat.id, '❌ Для оставления отзыва необходимо сначала купить этот товар.')
                return

            p = db.get_product(store_id, prod_id)
            user_states[f"{store_id}_{user_id}"] = {'step': 'rev_rating', 'prodId': prod_id}
            markup = types.InlineKeyboardMarkup(row_width=5)
            btns = [types.InlineKeyboardButton(f"⭐️ {s}", callback_data=f"setrev_{prod_id}_{s}") for s in range(1, 6)]
            markup.row(*btns)
            markup.row(types.InlineKeyboardButton('❌ Отмена', callback_data='back_main'))

            bot.send_message(
                call.message.chat.id,
                f"⭐ <b>Оценка товара «{p['title'] if p else ''}»</b>\nВыберите рейтинг:",
                parse_mode='HTML',
                reply_markup=markup
            )
            return

        if data.startswith('setrev_'):
            bot.answer_callback_query(call.id)
            parts = data.split('_')
            prod_id = int(parts[1])
            rating = int(parts[2])
            user_states[f"{store_id}_{user_id}"] = {'step': 'rev_comment', 'prodId': prod_id, 'rating': rating}
            bot.send_message(
                call.message.chat.id,
                f"⭐ Вы выбрали: <b>{rating}/5</b>\n\nНапишите ваш комментарий в ответном сообщении (или отправьте '-', если без текста):",
                parse_mode='HTML'
            )
            return

        # Deposit
        if data == 'deposit':
            bot.answer_callback_query(call.id)
            markup = types.InlineKeyboardMarkup()
            if store.get('card_requisites'):
                markup.row(types.InlineKeyboardButton('💳 Банковская карта', callback_data='dep_card'))
            if store.get('sbp_requisites'):
                markup.row(types.InlineKeyboardButton('📱 СБП', callback_data='dep_sbp'))
            if store.get('cryptobot_token'):
                markup.row(types.InlineKeyboardButton('🤖 Crypto Bot (USDT)', callback_data='dep_cryptobot'))
            if store.get('xrocket_token'):
                markup.row(types.InlineKeyboardButton('🚀 xRocket (USDT)', callback_data='dep_xrocket'))
            markup.row(types.InlineKeyboardButton('◀️ Назад', callback_data='back_main'))

            bot.send_message(
                call.message.chat.id,
                '💳 <b>Выберите способ пополнения баланса:</b>',
                parse_mode='HTML',
                reply_markup=markup
            )
            return

        if data in ['dep_card', 'dep_sbp', 'dep_cryptobot', 'dep_xrocket']:
            bot.answer_callback_query(call.id)
            method = data.replace('dep_', '')
            user_states[f"{store_id}_{user_id}"] = {'step': 'dep_amount', 'method': method}
            bot.send_message(call.message.chat.id, '💰 Введите сумму пополнения в рублях (минимум 10 ₽):')
            return

        # Support contact
        if data == 'support':
            bot.answer_callback_query(call.id)
            contact = store.get('support_contact') or 'Администратор не указал контакт.'
            bot.send_message(call.message.chat.id, f"💬 <b>Служба поддержки:</b>\n{contact}", parse_mode='HTML')
            return

        # Admin panel
        if data == 'admin_panel':
            if user_id != int(store['admin_id']):
                bot.answer_callback_query(call.id, 'Доступ запрещен', show_alert=True)
                return
            bot.answer_callback_query(call.id)
            stats = db.get_store_stats(store_id)
            text = (
                f"⚙️ <b>Панель управления магазином: {store['store_name']}</b>\n\n"
                f"📊 <b>Статистика:</b>\n"
                f"• Покупателей: <b>{stats['users']}</b>\n"
                f"• Товаров: <b>{stats['productsCount']}</b>\n"
                f"• Заказов: <b>{stats['ordersCount']}</b> (на <b>{stats['ordersVolume']} ₽</b>)\n"
                f"• Одобрено пополнений: <b>{stats['depositsCount']}</b> (на <b>{stats['depositsVolume']} ₽</b>)\n\n"
                f"Выберите раздел для настройки:"
            )
            markup = types.InlineKeyboardMarkup()
            markup.row(
                types.InlineKeyboardButton('📂 Категории', callback_data='adm_categories'),
                types.InlineKeyboardButton('🏷 Добавить товар', callback_data='adm_add_product')
            )
            markup.row(
                types.InlineKeyboardButton('💳 Реквизиты оплаты', callback_data='adm_requisites'),
                types.InlineKeyboardButton('⭐️ Отзывы', callback_data='adm_toggle_reviews')
            )
            markup.row(
                types.InlineKeyboardButton('🤖 Токены CryptoBot / xRocket', callback_data='adm_tokens'),
                types.InlineKeyboardButton('◀️ В главное меню', callback_data='back_main')
            )
            bot.send_message(call.message.chat.id, text, parse_mode='HTML', reply_markup=markup)
            return

        if data == 'adm_categories':
            if user_id != int(store['admin_id']):
                return
            bot.answer_callback_query(call.id)
            cats = db.get_categories(store_id)
            text = "📂 <b>Категории магазина:</b>\n\n"
            if not cats:
                text += "Категорий пока нет.\n"
            for i, c in enumerate(cats):
                text += f"{i + 1}. <b>{c['title']}</b>\n"

            markup = types.InlineKeyboardMarkup()
            markup.row(types.InlineKeyboardButton('➕ Добавить категорию', callback_data='adm_add_cat'))
            markup.row(types.InlineKeyboardButton('◀️ Назад в админку', callback_data='admin_panel'))
            bot.send_message(call.message.chat.id, text, parse_mode='HTML', reply_markup=markup)
            return

        if data == 'adm_add_cat':
            if user_id != int(store['admin_id']):
                return
            bot.answer_callback_query(call.id)
            user_states[f"{store_id}_{user_id}"] = {'step': 'adm_cat_title'}
            bot.send_message(call.message.chat.id, 'Введите название новой категории:')
            return

        if data == 'adm_add_product':
            if user_id != int(store['admin_id']):
                return
            bot.answer_callback_query(call.id)
            cats = db.get_categories(store_id)
            if not cats:
                markup = types.InlineKeyboardMarkup()
                markup.row(types.InlineKeyboardButton('➕ Добавить категорию', callback_data='adm_add_cat'))
                markup.row(types.InlineKeyboardButton('◀️ Назад', callback_data='admin_panel'))
                bot.send_message(call.message.chat.id, 'Сначала создайте хотя бы одну категорию!', reply_markup=markup)
                return

            user_states[f"{store_id}_{user_id}"] = {'step': 'adm_prod_title', 'catId': cats[0]['id']}
            bot.send_message(call.message.chat.id, 'Введите <b>название товара</b>:', parse_mode='HTML')
            return

        if data == 'adm_requisites':
            if user_id != int(store['admin_id']):
                return
            bot.answer_callback_query(call.id)
            text = (
                f"💳 <b>Реквизиты для оплаты</b>\n\n"
                f"• Карта: <code>{store.get('card_requisites') or 'не указана'}</code>\n"
                f"• СБП: <code>{store.get('sbp_requisites') or 'не указан'}</code>"
            )
            markup = types.InlineKeyboardMarkup()
            markup.row(types.InlineKeyboardButton('✏️ Изменить карту', callback_data='adm_set_card'))
            markup.row(types.InlineKeyboardButton('✏️ Изменить СБП', callback_data='adm_set_sbp'))
            markup.row(types.InlineKeyboardButton('◀️ Назад', callback_data='admin_panel'))
            bot.send_message(call.message.chat.id, text, parse_mode='HTML', reply_markup=markup)
            return

        if data == 'adm_set_card':
            if user_id != int(store['admin_id']):
                return
            bot.answer_callback_query(call.id)
            user_states[f"{store_id}_{user_id}"] = {'step': 'adm_set_card'}
            bot.send_message(call.message.chat.id, 'Введите номер карты и банк получателя:')
            return

        if data == 'adm_set_sbp':
            if user_id != int(store['admin_id']):
                return
            bot.answer_callback_query(call.id)
            user_states[f"{store_id}_{user_id}"] = {'step': 'adm_set_sbp'}
            bot.send_message(call.message.chat.id, 'Введите номер телефона и банк СБП:')
            return

        if data == 'adm_toggle_reviews':
            if user_id != int(store['admin_id']):
                return
            bot.answer_callback_query(call.id)
            curr = store.get('reviews_enabled', 1) != 0
            store['reviews_enabled'] = 0 if curr else 1
            db.update_store_setting(store_id, 'reviews_enabled', store['reviews_enabled'])
            msg = '✅ Система отзывов включена.' if store['reviews_enabled'] else '❌ Система отзывов отключена.'
            markup = types.InlineKeyboardMarkup()
            markup.row(types.InlineKeyboardButton('◀️ Назад', callback_data='admin_panel'))
            bot.send_message(call.message.chat.id, msg, reply_markup=markup)
            return

        if data == 'adm_tokens':
            if user_id != int(store['admin_id']):
                return
            bot.answer_callback_query(call.id)
            markup = types.InlineKeyboardMarkup()
            markup.row(types.InlineKeyboardButton('🤖 Токен CryptoBot', callback_data='adm_set_cryptobot'))
            markup.row(types.InlineKeyboardButton('🚀 Токен xRocket', callback_data='adm_set_xrocket'))
            markup.row(types.InlineKeyboardButton('◀️ Назад', callback_data='admin_panel'))
            bot.send_message(call.message.chat.id, '🔑 <b>Настройка криптовалютных шлюзов:</b>', parse_mode='HTML', reply_markup=markup)
            return

        if data == 'adm_set_cryptobot':
            if user_id != int(store['admin_id']):
                return
            bot.answer_callback_query(call.id)
            user_states[f"{store_id}_{user_id}"] = {'step': 'adm_set_cryptobot'}
            bot.send_message(call.message.chat.id, 'Введите API токен CryptoBot (от @CryptoBot -> Crypto Pay):')
            return

        if data == 'adm_set_xrocket':
            if user_id != int(store['admin_id']):
                return
            bot.answer_callback_query(call.id)
            user_states[f"{store_id}_{user_id}"] = {'step': 'adm_set_xrocket'}
            bot.send_message(call.message.chat.id, 'Введите API ключ xRocket (от @xrocket -> Pay):')
            return

    @bot.message_handler(content_types=['text'])
    def handle_text(message):
        st_key = f"{store_id}_{message.from_user.id}"
        st = user_states.get(st_key)
        if not st:
            return

        step = st.get('step')

        if step == 'adm_cat_title':
            user_states.pop(st_key, None)
            title = message.text.strip()
            db.add_category(store_id, title)
            markup = types.InlineKeyboardMarkup()
            markup.row(types.InlineKeyboardButton('📂 К категориям', callback_data='adm_categories'))
            markup.row(types.InlineKeyboardButton('◀️ В админку', callback_data='admin_panel'))
            bot.send_message(message.chat.id, f"✅ Категория «{title}» создана!", reply_markup=markup)
            return

        if step == 'adm_prod_title':
            st['title'] = message.text.strip()
            st['step'] = 'adm_prod_price'
            bot.send_message(message.chat.id, 'Введите <b>цену товара в рублях</b> (число):', parse_mode='HTML')
            return

        if step == 'adm_prod_price':
            try:
                price = float(message.text.strip())
                if price < 0:
                    raise ValueError
                st['price'] = price
                st['step'] = 'adm_prod_keys'
                bot.send_message(message.chat.id, 'Отправьте <b>ключи/товары</b> (каждый с новой строки) или 0:', parse_mode='HTML')
            except ValueError:
                bot.send_message(message.chat.id, 'Введите корректное число для цены:')
            return

        if step == 'adm_prod_keys':
            text = message.text.strip()
            pool = [] if text == '0' else [s.strip() for s in text.split('\n') if s.strip()]
            user_states.pop(st_key, None)
            db.add_product(store_id, st['catId'], st['title'], '', st['price'], pool)
            markup = types.InlineKeyboardMarkup()
            markup.row(types.InlineKeyboardButton('🏷 Добавить еще', callback_data='adm_add_product'))
            markup.row(types.InlineKeyboardButton('◀️ В админку', callback_data='admin_panel'))
            bot.send_message(message.chat.id, f"✅ Товар «{st['title']}» ({st['price']} ₽, {len(pool)} шт.) успешно добавлен!", reply_markup=markup)
            return

        if step == 'adm_set_card':
            user_states.pop(st_key, None)
            store['card_requisites'] = message.text.strip()
            db.update_store_setting(store_id, 'card_requisites', store['card_requisites'])
            markup = types.InlineKeyboardMarkup()
            markup.row(types.InlineKeyboardButton('◀️ В админку', callback_data='admin_panel'))
            bot.send_message(message.chat.id, '✅ Реквизиты карты обновлены!', reply_markup=markup)
            return

        if step == 'adm_set_sbp':
            user_states.pop(st_key, None)
            store['sbp_requisites'] = message.text.strip()
            db.update_store_setting(store_id, 'sbp_requisites', store['sbp_requisites'])
            markup = types.InlineKeyboardMarkup()
            markup.row(types.InlineKeyboardButton('◀️ В админку', callback_data='admin_panel'))
            bot.send_message(message.chat.id, '✅ Реквизиты СБП обновлены!', reply_markup=markup)
            return

        if step == 'adm_set_cryptobot':
            user_states.pop(st_key, None)
            store['cryptobot_token'] = message.text.strip()
            db.update_store_setting(store_id, 'cryptobot_token', store['cryptobot_token'])
            markup = types.InlineKeyboardMarkup()
            markup.row(types.InlineKeyboardButton('◀️ В админку', callback_data='admin_panel'))
            bot.send_message(message.chat.id, '✅ Токен CryptoBot сохранён!', reply_markup=markup)
            return

        if step == 'adm_set_xrocket':
            user_states.pop(st_key, None)
            store['xrocket_token'] = message.text.strip()
            db.update_store_setting(store_id, 'xrocket_token', store['xrocket_token'])
            markup = types.InlineKeyboardMarkup()
            markup.row(types.InlineKeyboardButton('◀️ В админку', callback_data='admin_panel'))
            bot.send_message(message.chat.id, '✅ Токен xRocket сохранён!', reply_markup=markup)
            return

        if step == 'rev_comment':
            prod_id = st['prodId']
            rating = st['rating']
            user_states.pop(st_key, None)
            comment = '' if message.text.strip() == '-' else message.text.strip()
            user_name = message.from_user.first_name or 'Покупатель'
            db.add_review(store_id, prod_id, message.from_user.id, user_name, rating, comment)
            bot.send_message(message.chat.id, '⭐️ <b>Спасибо за отзыв!</b> Ваша оценка сохранена.', parse_mode='HTML')
            return

        if step == 'dep_amount':
            try:
                amount = float(message.text.strip())
                if amount < 10:
                    bot.send_message(message.chat.id, 'Введите корректную сумму (минимум 10 ₽):')
                    return
            except ValueError:
                bot.send_message(message.chat.id, 'Введите число:')
                return

            method = st['method']
            user_states.pop(st_key, None)

            if method in ['card', 'sbp']:
                dep_id = db.create_deposit(store_id, message.from_user.id, amount, method)
                reqs = store.get('card_requisites') if method == 'card' else store.get('sbp_requisites')
                bot.send_message(
                    message.chat.id,
                    f"💳 <b>Заявка на пополнение #{dep_id}</b>\n\n"
                    f"Сумма: <b>{amount} ₽</b>\n"
                    f"Реквизиты для оплаты:\n<code>{reqs}</code>\n\n"
                    f"<i>Отправьте чек об оплате администратору для подтверждения.</i>",
                    parse_mode='HTML'
                )
                return

            if method in ['cryptobot', 'xrocket']:
                try:
                    inv = create_crypto_invoice(store, amount, method)
                    db.create_deposit(store_id, message.from_user.id, amount, method, None, inv['invoiceId'])
                    markup = types.InlineKeyboardMarkup()
                    markup.row(types.InlineKeyboardButton('Оплатить счет', url=inv['payUrl']))
                    bot.send_message(
                        message.chat.id,
                        f"💸 <b>Счёт на оплату создан!</b>\nСумма: <b>{amount} ₽</b> (≈ {inv['amountUsdt']} USDT)\n\nНажмите для оплаты:",
                        parse_mode='HTML',
                        reply_markup=markup
                    )
                except Exception as e:
                    bot.send_message(message.chat.id, f"❌ Ошибка создания счета: {e}")
                return

    return bot

def start_store_bot(store: dict, get_base_url_fn) -> bool:
    store_id = store['id']
    stop_store_bot(store_id)

    try:
        bot = build_store_bot(store, get_base_url_fn)
        active_bots[store_id] = bot

        def run_polling():
            try:
                print(f"[StoreBot] Starting polling for @{store.get('bot_username') or store_id}...")
                bot.infinity_polling(timeout=20, long_polling_timeout=20)
            except Exception as e:
                print(f"[StoreBot Polling Error @{store.get('bot_username') or store_id}]: {e}")

        t = threading.Thread(target=run_polling, daemon=True)
        t.start()
        active_threads[store_id] = t
        print(f"[StoreBot] @{store.get('bot_username') or store_id} successfully launched.")
        return True
    except Exception as err:
        print(f"[StoreBot] Failed to start @{store.get('bot_username') or store_id}: {err}")
        return False

def stop_store_bot(store_id: str):
    if store_id in active_bots:
        try:
            active_bots[store_id].stop_polling()
        except Exception:
            pass
        active_bots.pop(store_id, None)
        active_threads.pop(store_id, None)
        print(f"[StoreBot] {store_id} stopped.")
