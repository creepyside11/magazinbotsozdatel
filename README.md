# Telegram Магазин + Mini App (Сурсы)

Готовый исходный код Telegram-бота магазина цифровых товаров с полноценным Web Mini App.

## Структура
- `index.js` — точка входа, запуск сервера и бота.
- `bot.js` — логика Telegram-бота (каталог, заказы, админ-панель, пополнение).
- `server.js` — HTTP API и раздача статики Mini App.
- `public/` — фронтенд Mini App (HTML, CSS, JS).
- `db.js` — управление локальной базой данных SQLite.

## Переменные окружения (.env)
- `BOT_TOKEN` — токен бота от @BotFather
- `ADMIN_ID` — Telegram ID владельца (число)
