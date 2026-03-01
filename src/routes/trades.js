'use strict';
/**
 * GET /trades?mint=<tokenMint>&limit=<n>&after=<unixSeconds>&before=<unixSeconds>
 *
 * Returns indexed trades for a single token mint.
 * Response shape (array of):
 *  {
 *    id, signature, timestamp, side, price, solAmount, tokenAmount, trader
 *  }
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const logger = require('../logger');

router.get('/', async (req, res) => {
    const { mint, limit, after, before } = req.query;

    if (!mint) {
        return res.status(400).json({ error: '`mint` query param is required (token mint address)' });
    }

    const maxLimit = Math.min(parseInt(limit, 10) || 100, 500);
    const afterTs = after ? parseInt(after, 10) : null;
    const beforeTs = before ? parseInt(before, 10) : null;

    try {
        let sql = `SELECT id, signature, timestamp, side, price, sol_amount, token_amount, trader
                      FROM trades WHERE token_mint = ?`;
        const params = [mint];

        if (afterTs !== null) { sql += ` AND timestamp > ?`; params.push(afterTs); }
        if (beforeTs !== null) { sql += ` AND timestamp < ?`; params.push(beforeTs); }

        sql += ` ORDER BY timestamp DESC LIMIT ?`;
        params.push(maxLimit);

        const rows = await db.all(sql, params);

        logger.debug(`[/trades] mint=${mint.slice(0, 8)} → ${rows.length} trades`);

        return res.json(rows.map(r => ({
            id: r.id,
            signature: r.signature,
            timestamp: r.timestamp * 1000,   // convert to ms for the frontend
            type: r.side === 'buy' ? 'Buy' : 'Sell',
            price: r.price,              // raw lamports-per-token-unit (price in SOL)
            amount: r.sol_amount,         // SOL spent / received
            tokens: r.token_amount,       // token amount
            trader: r.trader || '',
        })));
    } catch (err) {
        logger.error(`[/trades] ${err.message}`);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
