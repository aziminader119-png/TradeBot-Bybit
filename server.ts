import {compressedAssets} from './src/server/api/staticAssets.ts';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { apiRouter } from './src/server/api/routes.ts';
import { AppWebSocketServer } from './src/server/api/wsServer.ts';
import { TradingEngine } from './src/server/engine/tradingEngine.ts';
import { acquireInstanceLock } from './src/server/instanceLock.ts';
import { attachFuturesMarket } from './src/server/api/futuresMarket.ts';
import { AuthGate } from './src/server/security/authGate.ts';
import { alertService } from './src/server/alerts/alertsApi.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  // Phase 1: single-instance guard runs before anything can talk to Bybit.
  const lock = acquireInstanceLock();
  if (!lock.ok) {
    console.error(`[Bybit Perpetual Bot] Refusing to start: ${lock.reason}`);
    process.exit(1);
  }

  // Phase 2: loopback by default. Any other bind address must be explicitly allowed and must use
  // Secure cookies (HTTPS via a reverse proxy) unless plain HTTP is explicitly accepted.
  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.HOST || '127.0.0.1';
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(HOST);
  const cookieSecure = process.env.TRADEBOT_COOKIE_SECURE === '1';
  const extraHosts = (process.env.TRADEBOT_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
  if (!isLoopback) {
    if (extraHosts.length === 0) {
      console.error('[Bybit Perpetual Bot] Refusing to bind to a non-loopback address without TRADEBOT_ALLOWED_HOSTS.');
      process.exit(1);
    }
    if (!cookieSecure && process.env.TRADEBOT_ALLOW_PLAIN_HTTP_REMOTE !== '1') {
      console.error('[Bybit Perpetual Bot] Remote access needs HTTPS (TRADEBOT_COOKIE_SECURE=1 behind a TLS proxy).');
      process.exit(1);
    }
  }
  const gate = new AuthGate({
    allowedHosts: extraHosts,
    cookieSecure,
    adminPassword: process.env.TRADEBOT_ADMIN_PASSWORD,
  });

  const app = express();
  app.disable('x-powered-by');
  // Every request passes the AuthGate first; only authorised requests reach Express.
  const server = http.createServer((req, res) => {
    gate.handleHttp(req, res).then((handled) => {
      if (!handled) app(req, res);
    }).catch((err) => {
      console.error('[Auth] gate error', err);
      if (!res.headersSent) { res.statusCode = 500; res.end(); }
    });
  });
  // Phase 4.3: `--prod` (used by `npm start`, works the same on Windows) or NODE_ENV=production serves the
  // built frontend from dist/ — no Vite dev server, no file watcher, no hot-reload socket.
  const isProd = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');
  app.use(express.json({ limit: '64kb' }));

  // Mount API router
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); }, apiRouter);

  // Attach WebSocket server for real-time frontend streaming
  const wsServer = AppWebSocketServer.getInstance();
  wsServer.attach(server, gate);
  const stopFuturesMarket=attachFuturesMarket(server,gate);

  const engine = TradingEngine.getInstance();

  // Vite middleware in dev or static serving in prod
  if (!isProd && fs.existsSync(path.resolve(__dirname, 'vite.config.ts'))) {
    const { createServer: createViteServer } = await import('vite');
    // Phase 4.3: hot reload is OFF unless TRADEBOT_HMR=1. The bot writes data/*.json continuously; with
    // hot reload on, Vite/Tailwind turned those writes into browser reloads (the login page kept reloading).
    const hmr = process.env.TRADEBOT_HMR === '1';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: hmr ? { server } : false,
        ws: hmr ? undefined : false,
        watch: hmr ? { ignored: ['**/data/**', '**/tests/**', '**/*.zip', '**/dist/**'] } : null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.log(`[Bybit Perpetual Bot] Development mode (Vite, hot reload ${hmr ? 'ON' : 'OFF'}). For normal use run: npm start`);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (!fs.existsSync(path.resolve(distPath, 'index.html'))) {
      console.error('[Bybit Perpetual Bot] dist/index.html is missing. Build the frontend first: npm run build (npm start does this for you).');
      process.exit(1);
    }
    app.use('/assets', compressedAssets(path.join(distPath, 'assets')));
    app.use('/assets', express.static(path.join(distPath, 'assets'), {maxAge: '1y', immutable: true}));
    app.use(express.static(distPath, {maxAge: 0}));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  // Phase 1: bind the port BEFORE the engine starts, so a port clash stops the process before any
  // Bybit request. The engine then starts in PAUSED mode (read-only sync, no automated orders).
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => {
      console.log(`[Bybit Perpetual Bot] Server listening on http://${HOST}:${PORT}`);
      resolve();
    });
  });
  await engine.start();
  // one indicator / Smart MART alert evaluator (monitoring only, never trades)
  const alerts = alertService();
  wsServer.setAlertSummary(() => alerts.summary());
  alerts.start();

  // Graceful shutdown
  const shutdown = () => {
    console.log('[Bybit Perpetual Bot] Shutting down...');
    engine.stop();
    alerts.stop();
    wsServer.destroy();
    stopFuturesMarket();
    lock.release();
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startServer().catch((err) => {
  console.error('[Server Error]', err);
  process.exit(1);
});


