import json
import os
import secrets
import telebot
from flask import Flask, request, jsonify, send_from_directory, Response
import db
import bot_manager

def create_app(get_base_url_fn):
    app = Flask(__name__, static_folder=None)

    public_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public')

    @app.after_request
    def add_cors_headers(response):
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-API-Key'
        return response

    @app.route('/app', defaults={'path': ''}, methods=['GET', 'OPTIONS'])
    @app.route('/app/<path:path>', methods=['GET', 'OPTIONS'])
    def serve_app(path):
        if request.method == 'OPTIONS':
            return Response(status=204)
        if not path or path == '/':
            return send_from_directory(os.path.join(public_dir, 'app'), 'index.html')
        return send_from_directory(os.path.join(public_dir, 'app'), path)

    @app.route('/docs', defaults={'path': ''}, methods=['GET', 'OPTIONS'])
    @app.route('/docs/<path:path>', methods=['GET', 'OPTIONS'])
    def serve_docs(path):
        if request.method == 'OPTIONS':
            return Response(status=204)
        if not path or path == '/':
            return send_from_directory(os.path.join(public_dir, 'docs'), 'index.html')
        return send_from_directory(os.path.join(public_dir, 'docs'), path)

    # ==========================================
    # STORE MINI APP API ENDPOINTS (/api/store/...)
    # ==========================================

    @app.route('/api/store/info', methods=['GET', 'OPTIONS'])
    def store_info():
        if request.method == 'OPTIONS':
            return Response(status=204)
        store_id = request.args.get('shop')
        if not store_id:
            return jsonify({'ok': False, 'error': 'Shop ID required'}), 400
        store = db.get_store(store_id)
        if not store:
            return jsonify({'ok': False, 'error': 'Shop not found'}), 404
        return jsonify({
            'ok': True,
            'store': {
                'id': store['id'],
                'name': store['store_name'],
                'support': store.get('support_contact') or '',
                'reviews_enabled': store.get('reviews_enabled', 1) != 0
            }
        })

    @app.route('/api/store/user', methods=['GET', 'OPTIONS'])
    def store_user():
        if request.method == 'OPTIONS':
            return Response(status=204)
        store_id = request.args.get('shop')
        user_id = request.args.get('userId', type=int)
        username = request.args.get('username', '')
        first_name = request.args.get('first_name', '')
        if not store_id or not user_id:
            return jsonify({'ok': False, 'error': 'Parameters missing'}), 400

        user = db.get_store_user(store_id, user_id, username, first_name)
        return jsonify({'ok': True, 'user': user})

    @app.route('/api/store/catalog', methods=['GET', 'OPTIONS'])
    def store_catalog():
        if request.method == 'OPTIONS':
            return Response(status=204)
        store_id = request.args.get('shop')
        if not store_id:
            return jsonify({'ok': False, 'error': 'Shop ID required'}), 400

        categories = db.get_categories(store_id)
        products = db.get_products(store_id)
        for p in products:
            p['rating'] = db.get_product_rating(store_id, p['id'])

        return jsonify({'ok': True, 'categories': categories, 'products': products})

    @app.route('/api/store/reviews', methods=['GET', 'OPTIONS'])
    def store_reviews():
        if request.method == 'OPTIONS':
            return Response(status=204)
        store_id = request.args.get('shop')
        product_id = request.args.get('productId', type=int)
        user_id = request.args.get('userId', type=int)
        if not store_id or not product_id:
            return jsonify({'ok': False, 'error': 'Missing parameters'}), 400

        store = db.get_store(store_id)
        if not store or store.get('reviews_enabled', 1) == 0:
            return jsonify({'ok': True, 'reviews': [], 'rating': {'average': 0, 'count': 0}, 'canReview': False, 'reviews_enabled': False})

        reviews = db.get_product_reviews(store_id, product_id)
        rating = db.get_product_rating(store_id, product_id)
        can_review = db.has_user_purchased_product(store_id, user_id, product_id) if user_id else False

        return jsonify({'ok': True, 'reviews': reviews, 'rating': rating, 'canReview': can_review, 'reviews_enabled': True})

    @app.route('/api/store/review', methods=['POST', 'OPTIONS'])
    def store_add_review():
        if request.method == 'OPTIONS':
            return Response(status=204)
        body = request.get_json(silent=True) or {}
        store_id = body.get('storeId')
        product_id = body.get('productId')
        user_id = body.get('userId')
        user_name = body.get('userName', 'Покупатель')
        rating = body.get('rating')
        comment = body.get('comment', '')

        if not store_id or not product_id or not user_id or not rating:
            return jsonify({'ok': False, 'error': 'Missing parameters'}), 400

        store = db.get_store(store_id)
        if not store or store.get('reviews_enabled', 1) == 0:
            return jsonify({'ok': False, 'error': 'Система отзывов отключена в данном магазине'}), 403

        if not db.has_user_purchased_product(store_id, user_id, product_id):
            return jsonify({'ok': False, 'error': 'Для оставления отзыва необходимо сначала купить этот товар'}), 403

        db.add_review(store_id, product_id, user_id, user_name, rating, comment)
        return jsonify({'ok': True})

    @app.route('/api/store/purchase', methods=['POST', 'OPTIONS'])
    def store_purchase():
        if request.method == 'OPTIONS':
            return Response(status=204)
        body = request.get_json(silent=True) or {}
        store_id = body.get('storeId')
        user_id = body.get('userId')
        product_id = body.get('productId')

        if not store_id or not user_id or not product_id:
            return jsonify({'ok': False, 'error': 'Missing parameters'}), 400

        user = db.get_store_user(store_id, user_id)
        prod = db.get_product(store_id, product_id)
        if not prod:
            return jsonify({'ok': False, 'error': 'Товар не найден'}), 404

        try:
            pool = json.loads(prod.get('content_pool') or '[]')
        except Exception:
            pool = []

        if not pool:
            return jsonify({'ok': False, 'error': 'Товара нет в наличии'}), 400

        if user['balance'] < prod['price']:
            return jsonify({'ok': False, 'error': 'Недостаточно средств на балансе'}), 400

        delivered = pool.pop(0)
        db.update_store_user_balance(store_id, user_id, -prod['price'])
        db.update_product_pool(store_id, product_id, pool)
        db.add_purchase(store_id, user_id, product_id, prod['title'], prod['price'], delivered)

        return jsonify({'ok': True, 'delivered': delivered})

    @app.route('/api/store/orders', methods=['GET', 'OPTIONS'])
    def store_orders():
        if request.method == 'OPTIONS':
            return Response(status=204)
        store_id = request.args.get('shop')
        user_id = request.args.get('userId', type=int)
        if not store_id or not user_id:
            return jsonify({'ok': False, 'error': 'Missing parameters'}), 400

        orders = db.get_user_purchases(store_id, user_id)
        return jsonify({'ok': True, 'orders': orders})

    # ==========================================
    # DEVELOPER PUBLIC REST API (/api/v1/...)
    # ==========================================

    @app.before_request
    def authenticate_v1():
        if request.path.startswith('/api/v1/'):
            if request.method == 'OPTIONS':
                return Response(status=204)

            auth_header = request.headers.get('Authorization', '')
            api_key_header = request.headers.get('X-API-Key', '')
            raw_key = api_key_header
            if not raw_key and auth_header.startswith('Bearer '):
                raw_key = auth_header.replace('Bearer ', '').strip()

            if not raw_key:
                return jsonify({'ok': False, 'error': 'Unauthorized: API Key missing'}), 401

            key_info = db.get_api_key_info(raw_key)
            if not key_info:
                return jsonify({'ok': False, 'error': 'Unauthorized: Invalid API Key'}), 403

            request.api_owner_id = key_info['owner_id']

    @app.route('/api/v1/stores', methods=['GET'])
    def v1_list_stores():
        owner_id = getattr(request, 'api_owner_id', None)
        stores = db.get_stores_by_owner(owner_id)
        return jsonify({'ok': True, 'count': len(stores), 'stores': stores})

    @app.route('/api/v1/stores', methods=['POST'])
    def v1_create_store():
        owner_id = getattr(request, 'api_owner_id', None)
        body = request.get_json(silent=True) or {}
        bot_token = body.get('botToken')
        admin_id = body.get('adminId')
        store_name = body.get('storeName')

        if not bot_token or not admin_id:
            return jsonify({'ok': False, 'error': 'botToken and adminId are required'}), 400

        try:
            test_bot = telebot.TeleBot(bot_token, threaded=False)
            me = test_bot.get_me()

            store_id = f"shop_{secrets.token_hex(4)}"
            name = store_name or me.first_name or 'Магазин'

            new_store = db.create_store(store_id, owner_id, bot_token, int(admin_id), me.username, name)
            bot_manager.start_store_bot(new_store, get_base_url_fn)

            app_url = bot_manager.get_public_miniapp_url(store_id, get_base_url_fn())
            return jsonify({
                'ok': True,
                'storeId': store_id,
                'botUsername': me.username,
                'storeName': name,
                'miniAppUrl': app_url
            })
        except Exception as e:
            return jsonify({'ok': False, 'error': f'Failed to verify or launch bot token: {e}'}), 400

    @app.route('/api/v1/stores/<store_id>', methods=['DELETE'])
    def v1_delete_store(store_id):
        owner_id = getattr(request, 'api_owner_id', None)
        store = db.get_store(store_id)
        if not store or store['owner_id'] != owner_id:
            return jsonify({'ok': False, 'error': 'Store not found'}), 404

        bot_manager.stop_store_bot(store_id)
        db.delete_store(store_id)
        return jsonify({'ok': True, 'deleted': store_id})

    return app
