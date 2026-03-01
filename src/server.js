'use strict';
/**
 * Entry point — Express HTTP server + WebSocket server
 *
 * Endpoints:
 *   POST   /index                  → start indexing a tokenMint
 *   DELETE /index/:mint            → stop indexing
 *   GET    /index                  → list active pollers
 *   GET    /health
 *   GET    /candles?mint=&resolution=&from=&to=
 *   GET    /latest-price?mint=
 *   WS     ws://host:port          → events: candle_update, price_update
 */

require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const logger = require('./logger');
const db = require('./db');
const broadcaster = require('./services/broadcaster');
const poller = require('./indexer/poller');

const candlesRoute = require('./routes/candles');
const priceRoute = require('./routes/price');
const healthRoute = require('./routes/health');
const indexerRoute = require('./routes/indexer');
const tradesRoute = require('./routes/trades');
const { fetchMints } = require('./config/mints');

const PORT = parseInt(process.env.INDEXER_PORT || '3001', 10);

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json());

app.use((req, _res, next) => {
    logger.debug(`→ ${req.method} ${req.url}`);
    next();
});

app.use('/health', healthRoute);
app.use('/candles', candlesRoute);
app.use('/latest-price', priceRoute);
app.use('/index', indexerRoute);
app.use('/trades', tradesRoute);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
    logger.error(`[server] ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
});

// ─── HTTP + WebSocket ─────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    logger.info(`[ws] Client connected (${ip}) — total: ${wss.clients.size}`);

    ws.send(JSON.stringify({
        event: 'connected',
        data: { message: 'Bonding Curve Indexer', timestamp: Math.floor(Date.now() / 1000) },
    }));

    ws.on('close', () => logger.info(`[ws] Client disconnected — total: ${wss.clients.size}`));
    ws.on('error', err => logger.warn(`[ws] error: ${err.message}`));
});

broadcaster.init(wss);

// ─── Graceful shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[server] ${signal} → graceful shutdown`);

    poller.stopAll();

    wss.close(() => logger.info('[server] WebSocket closed'));

    server.close(async () => {
        logger.info('[server] HTTP closed');
        await db.close();
        logger.info('[server] DB closed — bye');
        process.exit(0);
    });

    setTimeout(() => { logger.error('[server] Force exit'); process.exit(1); }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
    logger.info(`[server] 🚀 Bonding Curve Indexer on http://0.0.0.0:${PORT}`);
    logger.info(`[server]    POST /index          — start indexing a token mint`);
    logger.info(`[server]    GET  /index          — list active indexers`);
    logger.info(`[server]    GET  /health`);
    logger.info(`[server]    GET  /candles?mint=&resolution=&from=&to=`);
    logger.info(`[server]    GET  /latest-price?mint=`);
    logger.info(`[server]    WS   ws://localhost:${PORT}`);

    // ── Auto-detect mints from the Noottools panel API (runs every MINT_SYNC_INTERVAL_MS) ──
    const MINT_SYNC_INTERVAL_MS = parseInt(process.env.MINT_SYNC_INTERVAL_MS || '60000', 10);

    async function syncMints() {
        let mints;
        try {
            mints = await fetchMints();
        } catch (err) {
            logger.error(`[mint-sync] Failed to fetch mints: ${err.message}`);
            return;
        }

        if (mints.length === 0) {
            logger.warn('[mint-sync] No mints returned from panel API');
            return;
        }

        let newCount = 0;
        for (const { label, tokenMint, programId } of mints) {
            if (poller.isActive(tokenMint)) continue; // already running
            try {
                await poller.start(tokenMint, programId);
                logger.info(`[mint-sync] ✅ New mint detected & started: ${label || tokenMint.slice(0, 8)}`);
                newCount++;
            } catch (err) {
                logger.error(`[mint-sync] ❌ Failed to start ${label || tokenMint.slice(0, 8)}: ${err.message}`);
            }
        }

        const active = poller.list().length;
        logger.info(`[mint-sync] Sync done — ${active} active poller(s), ${newCount} newly started`);
    }

    // Run immediately, then repeat
    syncMints();
    setInterval(syncMints, MINT_SYNC_INTERVAL_MS).unref();
});

module.exports = { app, server };

