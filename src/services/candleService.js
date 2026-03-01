'use strict';
/**
 * OHLCV candle service — scoped per token_mint + resolution.
 */

const db = require('../db');

const RESOLUTIONS = {
    '1S': 1_000,
    '15S': 15_000,
    '1': 60_000,
    '5': 5 * 60_000,
    '15': 15 * 60_000,
    '30': 30 * 60_000,
    '60': 60 * 60_000,
    '240': 4 * 60 * 60_000,
    '1D': 24 * 60 * 60_000,
    '1W': 7 * 24 * 60 * 60_000,
    '1M': 30 * 24 * 60 * 60_000,
};

/**
 * Upsert a candle for every resolution based on a single trade.
 * @param {{ timestamp, price, tokenAmount, token_mint }} trade
 */
async function upsertCandlesForTrade(trade) {
    const { timestamp, price, tokenAmount, token_mint } = trade;
    const tradeMs = timestamp * 1000;

    for (const [resolution, intervalMs] of Object.entries(RESOLUTIONS)) {
        const openTime = Math.floor(tradeMs / intervalMs) * intervalMs;

        const existing = await db.get(
            `SELECT id FROM candles WHERE token_mint = ? AND resolution = ? AND open_time = ?`,
            [token_mint, resolution, openTime]
        );

        if (!existing) {
            await db.run(
                `INSERT INTO candles (token_mint, resolution, open_time, open, high, low, close, volume, trade_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
                [token_mint, resolution, openTime, price, price, price, price, tokenAmount, Math.floor(Date.now() / 1000)]
            );
        } else {
            await db.run(
                `UPDATE candles
         SET high        = MAX(high, ?),
             low         = MIN(low, ?),
             close       = ?,
             volume      = volume + ?,
             trade_count = trade_count + 1,
             updated_at  = ?
         WHERE token_mint = ? AND resolution = ? AND open_time = ?`,
                [price, price, price, tokenAmount, Math.floor(Date.now() / 1000), token_mint, resolution, openTime]
            );
        }
    }
}

/**
 * Fetch candles for a specific mint + resolution + time range.
 * @returns {Array<{ time, open, high, low, close, volume }>}
 */
async function getCandles(tokenMint, resolution, from, to) {
    if (!RESOLUTIONS[resolution]) {
        throw new Error(`Unsupported resolution: ${resolution}`);
    }
    const fromMs = from * 1000;
    const toMs = to * 1000;

    const rows = await db.all(
        `SELECT open_time, open, high, low, close, volume
     FROM candles
     WHERE token_mint = ? AND resolution = ? AND open_time >= ? AND open_time <= ?
     ORDER BY open_time ASC`,
        [tokenMint, resolution, fromMs, toMs]
    );

    return rows.map(r => ({
        time: r.open_time,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
    }));
}

/**
 * Fetch the latest price for a specific mint.
 * @returns {{ price, timestamp } | null}
 */
async function getLatestPrice(tokenMint) {
    const row = await db.get(
        `SELECT price, timestamp FROM trades WHERE token_mint = ? ORDER BY timestamp DESC LIMIT 1`,
        [tokenMint]
    );
    return row ? { price: row.price, timestamp: row.timestamp } : null;
}

module.exports = { upsertCandlesForTrade, getCandles, getLatestPrice, RESOLUTIONS };
