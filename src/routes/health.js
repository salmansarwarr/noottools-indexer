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
                programId: 'CPMWvEXzNTnrksm1PPXQzp2UUTXWxCKQaw9HhvDdf3nT',
                rpc: 'https://mainnet.helius-rpc.com/?api-key=6c7bdee8-475b-4fec-8897-91f7c3324425'.slice(0, 30) + '...',
                dbType: 'postgres',
            },
        });
    } catch (err) {
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
