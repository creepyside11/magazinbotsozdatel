const { bot, ADMIN_ID } = require('./bot');
const { createHttpServer } = require('./server');
const db = require('./db');
const { spawn } = require('child_process');

const PORT = 3000;

// Start HTTP Server
const server = createHttpServer(bot, ADMIN_ID);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Store] HTTP Server running on http://localhost:${PORT}`);
});

// Start SSH Pinggy Tunnel (Rock-solid, port 443 HTTPS without Cloudflare 1033 edge blocking)
function startTunnel() {
  console.log('[Tunnel] Starting Pinggy HTTPS Tunnel...');
  const tunnel = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ServerAliveInterval=30',
    '-p', '443',
    '-R0:localhost:' + PORT,
    'a.pinggy.io'
  ]);

  tunnel.stdout.on('data', (data) => {
    handleTunnelOutput(data.toString());
  });

  tunnel.stderr.on('data', (data) => {
    handleTunnelOutput(data.toString());
  });

  function handleTunnelOutput(text) {
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.(?:free\.pinggy\.net|run\.pinggy-free\.link)/);
    if (match) {
      const publicUrl = match[0];
      const current = db.getSetting('miniapp_url');
      if (current !== publicUrl) {
        console.log(`\n==============================================`);
        console.log(`[Tunnel] Mini App Public URL: ${publicUrl}`);
        console.log(`==============================================\n`);

        db.setSetting('miniapp_url', publicUrl);

        bot.telegram.sendMessage(
          ADMIN_ID,
          `🚀 <b>Ссылка на Mini App обновлена:</b>\n${publicUrl}\n\n` +
          `<i>Кнопка в боте перенастроена автоматически.</i>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    }
  }

  tunnel.on('close', (code) => {
    console.log(`[Tunnel] Exited with code ${code}. Reconnecting in 5s...`);
    setTimeout(startTunnel, 5000);
  });
}

// Start bot
bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log('[Bot] Telegram Bot successfully started.');
}).catch(err => {
  console.error('[Bot] Failed to launch bot:', err);
});
startTunnel();

// Graceful shutdown
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  server.close();
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  server.close();
});
