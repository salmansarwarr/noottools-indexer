'use strict';
const express = require('express');
const router = express.Router();
const { getLatestPrice } = require('../services/candleService');
const logger = require('../logger');

/**
 * GET /latest-price?mint=<tokenMint>
 */
router.get('/', async (req, res) => {
    const { mint } = req.query;

    if (!mint) {
        return res.status(400).json({ error: '`mint` query param is required' });
    }

    try {
        const data = await getLatestPrice(mint);
        if (!data) {
            return res.json({ price: null, timestamp: null, mint, message: 'No trades indexed yet for this mint' });
        }
        return res.json({ ...data, mint });
    } catch (err) {
        logger.error(`[/latest-price] ${err.message}`);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
