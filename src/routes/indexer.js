'use strict';
/**
 * POST   /index         — start indexing a token mint
 * DELETE /index/:mint   — stop indexing a token mint
 * GET    /index         — list all actively indexed mints
 *
 * Request body for POST:
 * {
 *   "tokenMint": "So11111111111111111111111111111111111111112",
 *   "programId": "optional — overrides PROGRAM_ID env"
 * }
 */

const express = require('express');
const router = express.Router();
const poller = require('../indexer/poller');
const { getStateForMint } = require('../indexer/state');
const logger = require('../logger');

// POST /index — start indexing
router.post('/', async (req, res) => {
    const { tokenMint, programId } = req.body || {};

    if (!tokenMint || typeof tokenMint !== 'string') {
        return res.status(400).json({ error: '`tokenMint` (string) is required in request body' });
    }

    try {
        await poller.start(tokenMint.trim(), programId?.trim());
        logger.info(`[/index] Started indexer for ${tokenMint}`);
        return res.status(200).json({
            success: true,
            tokenMint,
            message: poller.isActive(tokenMint) ? 'Indexer started' : 'Already running',
        });
    } catch (err) {
        logger.error(`[/index] Failed to start: ${err.message}`);
        return res.status(400).json({ error: err.message });
    }
});

// DELETE /index/:mint — stop indexing
router.delete('/:mint', (req, res) => {
    const tokenMint = req.params.mint;
    const stopped = poller.stop(tokenMint);

    if (!stopped) {
        return res.status(404).json({ error: `No active indexer for mint: ${tokenMint}` });
    }

    logger.info(`[/index] Stopped indexer for ${tokenMint}`);
    return res.json({ success: true, tokenMint, message: 'Indexer stopped' });
});

// GET /index — list active pollers with their DB state
router.get('/', async (req, res) => {
    const active = poller.list();

    // Enrich with DB state
    const enriched = await Promise.all(
        active.map(async entry => {
            const state = await getStateForMint(entry.tokenMint).catch(() => ({}));
            return {
                ...entry,
                lastSignature: state.last_signature || null,
                lastProcessedAt: state.last_processed_at ? parseInt(state.last_processed_at, 10) : null,
                totalTrades: state.total_trades ? parseInt(state.total_trades, 10) : 0,
            };
        })
    );

    return res.json({ count: enriched.length, indexers: enriched });
});

module.exports = router;
