// Integrations for CryptoBot and xRocket
const db = require('./db');

async function createCryptoBotInvoice(amountRub, description = 'Пополнение баланса') {
  const token = db.getSetting('cryptobot_token');
  if (!token) {
    throw new Error('Crypto Bot токен не настроен в админ-панели');
  }

  const rate = parseFloat(db.getSetting('usdt_rate') || '95');
  const amountUsdt = Math.max(0.1, +(amountRub / rate).toFixed(2));

  // Mainnet Crypto Pay API endpoint
  const url = 'https://pay.crypt.bot/api/createInvoice';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Crypto-Pay-API-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      asset: 'USDT',
      amount: amountUsdt.toString(),
      description: `${description} (${amountRub} RUB)`,
      expires_in: 3600
    })
  });

  const resJson = await response.json();
  if (!resJson.ok) {
    throw new Error(resJson.error?.name || 'Ошибка создания счёта CryptoBot');
  }

  return {
    invoiceId: resJson.result.invoice_id,
    payUrl: resJson.result.bot_invoice_url || resJson.result.pay_url,
    amountUsdt
  };
}

async function createXRocketInvoice(amountRub, description = 'Пополнение баланса') {
  const token = db.getSetting('xrocket_token');
  if (!token) {
    throw new Error('xRocket токен не настроен в админ-панели');
  }

  const rate = parseFloat(db.getSetting('usdt_rate') || '95');
  const amountUsdt = Math.max(0.1, +(amountRub / rate).toFixed(2));

  // xRocket official Pay API endpoint: https://pay.xrocket.tg/tg-invoices
  const url = 'https://pay.xrocket.tg/tg-invoices';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Rocket-Pay-Key': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      amount: amountUsdt,
      currency: 'USDT',
      description: `${description} (${amountRub} RUB)`,
      numPayments: 1
    })
  });

  const resJson = await response.json();
  if (!resJson.success) {
    throw new Error(resJson.message || 'Ошибка создания счёта xRocket');
  }

  return {
    invoiceId: resJson.data.id,
    payUrl: resJson.data.link,
    amountUsdt
  };
}

module.exports = {
  createCryptoBotInvoice,
  createXRocketInvoice
};
