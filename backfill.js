// backfill.js
'use strict';
require('dotenv').config();
const db = require('./src/db');
const { upsertCandlesForTrade } = require('./src/services/candleService');
const logger = require('./src/logger');

async function backfill(tokenMint) {
    const trades = await db.all(
        `SELECT * FROM trades WHERE token_mint = ? ORDER BY timestamp ASC`,
        [tokenMint]
    );
    logger.info(`Backfilling ${trades.length} trades for ${tokenMint.slice(0, 8)}`);
    for (const trade of trades) {
        trade.tokenAmount = trade.token_amount; // map column name to expected field
        trade.solAmount = trade.sol_amount;
        await upsertCandlesForTrade(trade);
    }
    logger.info('Backfill complete');
    process.exit(0);
}

backfill('DvcDmgDsq5PBpokrj7pY2XvbiEbhPGYDemPV6X92HYc7');