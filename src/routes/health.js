'use strict';
const express = require('express');
const router = express.Router();
const poller = require('../indexer/poller');
const { getAllMintStates } = require('../indexer/state');

/**
 * GET /health
 */
router.get('/', async (req, res) => {
    try {
        const allStates = await getAllMintStates();
        const activePollers = poller.list();

        return res.json({
            status: 'ok',
            uptime: Math.floor(process.uptime()),
            activeIndexers: activePollers.length,
            indexers: activePollers.map(p => ({
                tokenMint: p.tokenMint,
                totalTrades: allStates[p.tokenMint]?.total_trades ? parseInt(allStates[p.tokenMint].total_trades, 10) : 0,
                lastProcessedAt: allStates[p.tokenMint]?.last_processed_at ? parseInt(allStates[p.tokenMint].last_processed_at, 10) : null,
                lastSignature: allStates[p.tokenMint]?.last_signature || null,
                startedAt: p.startedAt,
            })),
            env: {
                programId: process.env.PROGRAM_ID || '(not set)',
                rpc: process.env.SOLANA_RPC_URL ? '(configured)' : 'public (rate limited)',
                dbType: process.env.DB_TYPE || 'sqlite',
            },
        });
    } catch (err) {
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
