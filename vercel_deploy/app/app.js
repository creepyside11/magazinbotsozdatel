const tg = window.Telegram?.WebApp;
if (tg) {
  tg.expand();
  tg.enableClosingConfirmation();
  if (tg.setHeaderColor) tg.setHeaderColor('#09090b');
  if (tg.setBackgroundColor) tg.setBackgroundColor('#09090b');
}

// URL query params
const urlParams = new URLSearchParams(window.location.search);
const currentShopId = urlParams.get('shop') || '';
const customApiBase = urlParams.get('api') || '';

function apiUrl(endpoint) {
  const base = customApiBase.replace(/\/+$/, '');
  const sep = endpoint.includes('?') ? '&' : '?';
  const shopParam = currentShopId ? `${sep}shop=${encodeURIComponent(currentShopId)}` : '';
  if (base) {
    return `${base}${endpoint}${shopParam}`;
  }
  return `${endpoint}${shopParam}`;
}
let currentUser = {
  id: tg?.initDataUnsafe?.user?.id || 8282599467,
  first_name: tg?.initDataUnsafe?.user?.first_name || 'Пользователь',
  username: tg?.initDataUnsafe?.user?.username || '',
  balance: 0
};

let categories = [];
let products = [];
let currentCategory = 'all';
let selectedProduct = null;

let cart = [];
let botUsername = '';
let reviewsEnabledGlobal = true;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  setupModals();
  setupCart();
  setupPromo();
  await loadProfile();
  await loadCatalog();
  await loadOrders();
});

function setupPromo() {
  const promoModal = document.getElementById('modal-promo');
  document.getElementById('btn-open-promo').addEventListener('click', () => {
    promoModal.classList.add('open');
  });
  document.getElementById('modal-promo-close').addEventListener('click', () => {
    promoModal.classList.remove('open');
  });

  document.getElementById('btn-submit-promo').addEventListener('click', async () => {
    const code = document.getElementById('promo-input').value.trim();
    if (!code) return alert('Введите код');

    try {
      const res = await fetch(apiUrl('/api/promo/activate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id, code })
      });
      const data = await res.json();
      if (data.ok) {
        if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        alert(`Промокод активирован! Зачислено: +${data.reward} ₽`);
        promoModal.classList.remove('open');
        document.getElementById('promo-input').value = '';
        await loadProfile();
      } else {
        if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('error');
        alert(data.error || 'Ошибка');
      }
    } catch(e) {
      alert('Ошибка соединения');
    }
  });

  // Setup Review Submit
  const reviewModal = document.getElementById('modal-review');
  document.getElementById('btn-write-review').addEventListener('click', () => {
    reviewModal.classList.add('open');
  });
  document.getElementById('modal-review-close').addEventListener('click', () => {
    reviewModal.classList.remove('open');
  });

  let selectedRating = 5;
  document.querySelectorAll('.star-btn').forEach(b => {
    b.addEventListener('click', () => {
      selectedRating = parseInt(b.dataset.rating);
      document.querySelectorAll('.star-btn').forEach(sb => {
        sb.classList.toggle('active', parseInt(sb.dataset.rating) <= selectedRating);
      });
    });
  });

  document.getElementById('btn-submit-review').addEventListener('click', async () => {
    const comment = document.getElementById('review-comment').value.trim();
    if (!selectedProduct) return;

    try {
      const res = await fetch(apiUrl('/api/product/review'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: selectedProduct.id,
          userId: currentUser.id,
          userName: currentUser.first_name,
          rating: selectedRating,
          comment
        })
      });
      const data = await res.json();
      if (data.ok) {
        alert('Спасибо за ваш отзыв!');
        reviewModal.classList.remove('open');
        document.getElementById('review-comment').value = '';
        loadProductReviews(selectedProduct.id);
      } else {
        alert(data.error || 'Не удалось оставить отзыв');
      }
    } catch(e) {
      alert('Ошибка при отправке отзыва');
    }
  });
}

function setupCart() {
  const cartModal = document.getElementById('modal-cart');
  document.getElementById('btn-open-cart').addEventListener('click', () => {
    renderCart();
    cartModal.classList.add('open');
  });
  document.getElementById('modal-cart-close').addEventListener('click', () => {
    cartModal.classList.remove('open');
  });

  document.getElementById('btn-add-to-cart').addEventListener('click', () => {
    if (!selectedProduct) return;
    cart.push(selectedProduct);
    updateCartBadge();
    if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    alert(`Товар «${selectedProduct.title}» добавлен в корзину!`);
    document.getElementById('modal-product').classList.remove('open');
  });

  document.getElementById('btn-checkout-cart').addEventListener('click', async () => {
    if (cart.length === 0) return;
    const total = cart.reduce((sum, p) => sum + p.price, 0);

    if (currentUser.balance < total) {
      alert(`Недостаточно средств. Нужно: ${total} ₽, у вас: ${currentUser.balance} ₽.`);
      cartModal.classList.remove('open');
      document.getElementById('modal-deposit').classList.add('open');
      return;
    }

    if (!confirm(`Оплатить ${cart.length} товаров на сумму ${total} ₽?`)) return;

    // Process all cart items sequentially
    let successCount = 0;
    for (const p of cart) {
      try {
        const res = await fetch(apiUrl('/api/purchase'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: currentUser.id, productId: p.id })
        });
        const d = await res.json();
        if (d.ok) successCount++;
      } catch(e) {}
    }

    cart = [];
    updateCartBadge();
    cartModal.classList.remove('open');
    alert(`Успешно приобретено товаров: ${successCount} шт.! Они отправлены в бот и доступны в «Покупках».`);
    await loadProfile();
    await loadCatalog();
    await loadOrders();
  });
}

function updateCartBadge() {
  const badge = document.getElementById('cart-badge');
  badge.innerText = cart.length;
  badge.style.display = cart.length > 0 ? 'flex' : 'none';
}

function renderCart() {
  const list = document.getElementById('cart-items-list');
  const summary = document.getElementById('cart-summary');
  if (cart.length === 0) {
    list.innerHTML = `<div class="empty-state">Корзина пуста</div>`;
    summary.style.display = 'none';
    return;
  }

  summary.style.display = 'block';
  list.innerHTML = '';
  let total = 0;

  cart.forEach((p, idx) => {
    total += p.price;
    const item = document.createElement('div');
    item.className = 'cart-item';
    item.innerHTML = `
      <div>
        <div style="font-weight:600">${escapeHtml(p.title)}</div>
        <div style="font-size:12px;color:var(--text-dim)">${p.price} ₽</div>
      </div>
      <button class="btn-text" style="color:#ef4444" data-idx="${idx}">Удалить</button>
    `;
    item.querySelector('button').addEventListener('click', (e) => {
      cart.splice(idx, 1);
      updateCartBadge();
      renderCart();
    });
    list.appendChild(item);
  });

  document.getElementById('cart-total-val').innerText = `${total} ₽`;
}
function setupNavigation() {
  const navItems = document.querySelectorAll('.bottom-nav .nav-item');
  const tabs = document.querySelectorAll('.tab-pane');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const tabId = item.dataset.tab;
      navItems.forEach(b => b.classList.remove('active'));
      item.classList.add('active');

      tabs.forEach(pane => {
        pane.classList.remove('active');
        if (pane.id === `tab-${tabId}`) pane.classList.add('active');
      });

      if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
    });
  });

  document.getElementById('link-orders').addEventListener('click', () => {
    document.querySelector('.bottom-nav .nav-item[data-tab="orders"]').click();
  });

  document.getElementById('link-support').addEventListener('click', () => {
    document.querySelector('.bottom-nav .nav-item[data-tab="support"]').click();
  });
}

function setupModals() {
  const depositModal = document.getElementById('modal-deposit');
  const prodModal = document.getElementById('modal-product');

  document.getElementById('btn-open-deposit').addEventListener('click', () => {
    depositModal.classList.add('open');
  });

  document.getElementById('modal-deposit-close').addEventListener('click', () => {
    depositModal.classList.remove('open');
  });

  document.getElementById('modal-prod-close').addEventListener('click', () => {
    prodModal.classList.remove('open');
  });

  // Handle deposit submit
  document.getElementById('btn-confirm-deposit').addEventListener('click', async () => {
    const amount = parseFloat(document.getElementById('deposit-amount').value);
    const method = document.querySelector('input[name="dep_method"]:checked')?.value;

    if (!amount || amount < 10) {
      alert('Минимальная сумма пополнения: 10 ₽');
      return;
    }

    try {
      const res = await fetch(apiUrl('/api/deposit/create'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: currentUser.id,
          amount,
          method
        })
      });
      const data = await res.json();

      if (data.ok) {
        depositModal.classList.remove('open');
        if (data.action === 'manual') {
          // Instruct user to switch to bot for manual transfer
          alert(`Заявка создана. Перейдите в чат с ботом, чтобы получить реквизиты и отправить чек.`);
          if (tg) tg.close();
        } else if (data.payUrl) {
          if (tg?.openTelegramLink && data.payUrl.startsWith('https://t.me')) {
            tg.openTelegramLink(data.payUrl);
          } else {
            window.location.href = data.payUrl;
          }
        }
      } else {
        alert(data.error || 'Ошибка создания заявки');
      }
    } catch (e) {
      alert('Ошибка соединения с сервером');
    }
  });

  // Handle Buy Product
  document.getElementById('btn-buy-product').addEventListener('click', async () => {
    if (!selectedProduct) return;

    if (currentUser.balance < selectedProduct.price) {
      alert('Недостаточно средств на балансе. Пожалуйста, пополните счет.');
      document.getElementById('modal-product').classList.remove('open');
      document.getElementById('modal-deposit').classList.add('open');
      return;
    }

    const conf = confirm(`Подтверждаете покупку "${selectedProduct.title}" за ${selectedProduct.price} ₽?`);
    if (!conf) return;

    try {
      const res = await fetch(apiUrl('/api/purchase'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: currentUser.id,
          productId: selectedProduct.id
        })
      });
      const data = await res.json();

      if (data.ok) {
        alert('Покупка успешно совершена! Товар отправлен вам в чат бота и сохранен во вкладке "Покупки".');
        document.getElementById('modal-product').classList.remove('open');
        await loadProfile();
        await loadCatalog();
        await loadOrders();
      } else {
        alert(data.error || 'Ошибка при покупке');
      }
    } catch (e) {
      alert('Ошибка при покупке');
    }
  });

  // Search filter
  document.getElementById('catalog-search').addEventListener('input', (e) => {
    renderProducts(e.target.value);
  });
}

async function loadProfile() {
  try {
    const res = await fetch(apiUrl(`/api/user?id=${currentUser.id}&username=${encodeURIComponent(currentUser.username)}&first_name=${encodeURIComponent(currentUser.first_name)}`));
    const data = await res.json();
    if (data.ok && data.user) {
      if (typeof data.reviews_enabled !== 'undefined') {
        reviewsEnabledGlobal = data.reviews_enabled;
      }
      currentUser.balance = data.user.balance;
      document.getElementById('user-name').innerText = data.user.first_name || 'Клиент';
      document.getElementById('user-balance').innerText = `${data.user.balance.toFixed(2)} ₽`;
      document.getElementById('profile-id').innerText = data.user.id;
      document.getElementById('profile-balance-val').innerText = `${data.user.balance.toFixed(2)} ₽`;
      
      if (data.store_name) {
        document.querySelector('.brand-title').innerText = data.store_name.toUpperCase();
      }

      // Referral system section
      const refSection = document.getElementById('ref-panel-section');
      if (data.ref_system && data.ref_system.enabled) {
        refSection.style.display = 'block';
        document.getElementById('ref-rate-badge').innerText = `${data.ref_system.percent}%`;
        document.getElementById('ref-count-val').innerText = `${data.ref_system.referralsCount} чел.`;
        
        document.getElementById('btn-copy-ref').onclick = () => {
          const refLink = `https://t.me/EmeraldStoreTermux_bot?start=ref_${currentUser.id}`;
          if (navigator.clipboard) {
            navigator.clipboard.writeText(refLink);
            alert('Реферальная ссылка скопирована в буфер обмена!');
          } else {
            prompt('Ваша ссылка для приглашения:', refLink);
          }
        };
      } else {
        refSection.style.display = 'none';
      }

      // Legal links
      const privElem = document.getElementById('link-privacy');
      if (data.privacy_policy_url) {
        privElem.style.display = 'flex';
        privElem.onclick = () => {
          if (tg?.openLink) tg.openLink(data.privacy_policy_url);
          else window.open(data.privacy_policy_url, '_blank');
        };
      } else {
        privElem.style.display = 'none';
      }

      const termsElem = document.getElementById('link-terms');
      if (data.terms_of_service_url) {
        termsElem.style.display = 'flex';
        termsElem.onclick = () => {
          if (tg?.openLink) tg.openLink(data.terms_of_service_url);
          else window.open(data.terms_of_service_url, '_blank');
        };
      } else {
        termsElem.style.display = 'none';
      }
    }
    if (data.support_contact) {
      const btn = document.getElementById('support-link-btn');
      btn.href = data.support_contact.startsWith('@') 
        ? `https://t.me/${data.support_contact.replace('@', '')}` 
        : data.support_contact;
    }
  } catch (err) {
    console.error('loadProfile error', err);
  }
}

async function loadCatalog() {
  try {
    const [resCats, resProds] = await Promise.all([
      fetch(apiUrl('/api/categories')),
      fetch(apiUrl('/api/products'))
    ]);
    const catsData = await resCats.json();
    const prodsData = await resProds.json();

    if (catsData.ok) {
      categories = catsData.categories;
      renderCategories();
    }
    if (prodsData.ok) {
      products = prodsData.products;
      renderProducts();
    }
  } catch (err) {
    console.error('loadCatalog error', err);
  }
}

function renderCategories() {
  const container = document.getElementById('category-chips');
  container.innerHTML = `<button class="cat-pill active" data-cat="all">Все</button>`;

  categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'cat-pill';
    btn.dataset.cat = cat.id;
    btn.innerText = cat.title;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentCategory = cat.id;
      renderProducts(document.getElementById('catalog-search').value);
    });
    container.appendChild(btn);
  });

  container.querySelector('[data-cat="all"]').addEventListener('click', (e) => {
    document.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    currentCategory = 'all';
    renderProducts(document.getElementById('catalog-search').value);
  });
}

function renderProducts(searchQuery = '') {
  const grid = document.getElementById('product-grid');
  grid.innerHTML = '';

  const query = searchQuery.trim().toLowerCase();
  const filtered = products.filter(p => {
    const matchCat = (currentCategory === 'all' || String(p.category_id) === String(currentCategory));
    const matchSearch = !query || p.title.toLowerCase().includes(query) || (p.description && p.description.toLowerCase().includes(query));
    return matchCat && matchSearch;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="empty-state">Товары не найдены</div>`;
    return;
  }

  filtered.forEach(p => {
    let stock = 0;
    try {
      stock = JSON.parse(p.content_pool || '[]').length;
    } catch (e) {}

    const card = document.createElement('div');
    card.className = 'product-card';

    const imgHtml = p.image_url
      ? `<img src="${escapeHtml(p.image_url)}" class="product-card-thumb" alt="${escapeHtml(p.title)}" loading="lazy">`
      : '';

    const ratingHtml = (p.rating && p.rating.count > 0)
      ? `<div class="prod-card-rating">★ ${p.rating.average} <span style="opacity:0.7">(${p.rating.count})</span></div>`
      : '';

    card.innerHTML = `
      <div>
        ${imgHtml}
        <div class="prod-badge-row">
          <div class="prod-badge">${p.category_title || 'Каталог'}</div>
          ${ratingHtml}
        </div>
        <div class="prod-title">${escapeHtml(p.title)}</div>
        <div class="prod-stock">В наличии: ${stock} шт.</div>
      </div>
      <div class="prod-foot">
        <span class="prod-price">${p.price} ₽</span>
        <button class="btn-pill-small" ${stock === 0 ? 'disabled style="opacity:0.4"' : ''}>
          ${stock > 0 ? 'Купить' : 'Нет'}
        </button>
      </div>
    `;

    card.addEventListener('click', () => {
      if (stock === 0) {
        alert('Товара временно нет в наличии');
        return;
      }
      openProductModal(p, stock);
    });

    grid.appendChild(card);
  });
}

async function openProductModal(prod, stock) {
  selectedProduct = prod;
  document.getElementById('modal-prod-title').innerText = prod.title;
  document.getElementById('modal-prod-price').innerText = `${prod.price} ₽`;
  document.getElementById('modal-prod-stock').innerText = `В наличии: ${stock} шт.`;
  document.getElementById('modal-prod-desc').innerText = prod.description || 'Описание отсутствует.';

  const imgWrap = document.getElementById('modal-prod-image-wrap');
  const imgElem = document.getElementById('modal-prod-img');
  if (prod.image_url) {
    imgElem.src = prod.image_url;
    imgWrap.style.display = 'block';
  } else {
    imgWrap.style.display = 'none';
  }

  loadProductReviews(prod.id);
  document.getElementById('modal-product').classList.add('open');
}

async function loadProductReviews(productId) {
  try {
    const res = await fetch(apiUrl(`/api/product/reviews?productId=${productId}&userId=${currentUser.id}`));
    const data = await res.json();
    const list = document.getElementById('modal-reviews-list');
    const ratingTag = document.getElementById('modal-prod-rating');
    const writeBtn = document.getElementById('btn-write-review');
    const reviewsSec = document.querySelector('.reviews-section');

    if (data.reviews_enabled === false) {
      if (reviewsSec) reviewsSec.style.display = 'none';
      if (ratingTag) ratingTag.style.display = 'none';
      return;
    } else {
      if (reviewsSec) reviewsSec.style.display = 'block';
      if (ratingTag) ratingTag.style.display = 'block';
    }

    if (writeBtn) {
      if (data.canReview) {
        writeBtn.style.display = 'inline-block';
      } else {
        writeBtn.style.display = 'none';
      }
    }

    if (data.ok) {
      ratingTag.innerText = `★ ${data.rating.average} (${data.rating.count} отзывов)`;
      if (data.reviews.length === 0) {
        list.innerHTML = `<div style="font-size:12px;color:var(--text-dim);text-align:center;padding:10px 0;">Отзывов пока нет.${data.canReview ? ' Оставьте первый отзыв!' : ''}</div>`;
      } else {
        list.innerHTML = '';
        data.reviews.forEach(r => {
          const item = document.createElement('div');
          item.className = 'review-item';
          item.innerHTML = `
            <div class="review-head">
              <span>${escapeHtml(r.user_name)}</span>
              <span>★ ${r.rating}</span>
            </div>
            <div class="review-body">${escapeHtml(r.comment || 'Без комментария')}</div>
          `;
          list.appendChild(item);
        });
      }
    }
  } catch(e) {}
}

async function loadOrders() {
  try {
    const res = await fetch(apiUrl(`/api/orders?userId=${currentUser.id}`));
    const data = await res.json();
    const list = document.getElementById('orders-list');
    const countTag = document.getElementById('orders-count');

    if (data.ok && data.orders.length > 0) {
      countTag.innerText = data.orders.length;
      list.innerHTML = '';
      data.orders.forEach(order => {
        const item = document.createElement('div');
        item.className = 'glass-panel order-card';
        const reviewBtnHtml = reviewsEnabledGlobal !== false && order.product_id
          ? `<button class="btn-text" style="color:#60a5fa;font-size:12px;margin-top:8px;" data-prod-id="${order.product_id}" data-prod-title="${escapeHtml(order.product_title)}">⭐️ Оставить отзыв о товаре</button>`
          : '';

        item.innerHTML = `
          <div class="order-header">
            <span>Заказ #${order.id}</span>
            <span>${new Date(order.created_at).toLocaleDateString('ru-RU')}</span>
          </div>
          <div class="order-title">${escapeHtml(order.product_title)} (${order.price} ₽)</div>
          <div class="order-content-box">${escapeHtml(order.delivered_content)}</div>
          ${reviewBtnHtml}
        `;

        const rBtn = item.querySelector('button[data-prod-id]');
        if (rBtn) {
          rBtn.addEventListener('click', () => {
            selectedProduct = { id: order.product_id, title: order.product_title };
            const reviewModal = document.getElementById('modal-review');
            if (reviewModal) reviewModal.classList.add('open');
          });
        }

        list.appendChild(item);
      });
    } else {
      countTag.innerText = '0';
      list.innerHTML = `<div class="empty-state">У вас пока нет оформленных заказов.</div>`;
    }
  } catch (err) {
    console.error('loadOrders error', err);
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m]);
}
