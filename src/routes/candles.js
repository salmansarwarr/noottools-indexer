'use strict';
const express = require('express');
const router = express.Router();
const { getCandles, RESOLUTIONS } = require('../services/candleService');
const logger = require('../logger');

/**
 * GET /candles?mint=<tokenMint>&resolution=1&from=<unix>&to=<unix>
 */
router.get('/', async (req, res) => {
    const { mint, resolution, from, to } = req.query;

    if (!mint) {
        return res.status(400).json({ error: '`mint` query param is required (token mint address)' });
    }
    if (!resolution) {
        return res.status(400).json({ error: '`resolution` query param is required' });
    }
    if (!RESOLUTIONS[resolution]) {
        return res.status(400).json({
            error: `Unsupported resolution "${resolution}". Supported: ${Object.keys(RESOLUTIONS).join(', ')}`,
        });
    }

    const fromTs = parseInt(from, 10) || 0;
    const toTs = parseInt(to, 10) || Math.floor(Date.now() / 1000) + 86400;

    try {
        const candles = await getCandles(mint, resolution, fromTs, toTs);
        logger.debug(`[/candles] mint=${mint.slice(0, 8)} res=${resolution} → ${candles.length} bars`);
        return res.json(candles);
    } catch (err) {
        logger.error(`[/candles] ${err.message}`);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
