'use strict';
/**
 * Per-mint indexer state stored in the `indexer_state` table.
 * All state is scoped by tokenMint, so multiple mints can run concurrently.
 */

const db = require('../db');

async function ensureMintState(tokenMint) {
    // Upsert the two required state rows for a new mint
    for (const key of ['last_signature', 'last_processed_at', 'total_trades']) {
        await db.run(
            `INSERT OR IGNORE INTO indexer_state (token_mint, key, value) VALUES (?, ?, ?)`,
            [tokenMint, key, key === 'total_trades' ? '0' : null]
        );
    }
}

async function getLastSignature(tokenMint) {
    const row = await db.get(
        `SELECT value FROM indexer_state WHERE token_mint = ? AND key = 'last_signature'`,
        [tokenMint]
    );
    return row?.value || null;
}

async function setLastSignature(tokenMint, signature) {
    await db.run(
        `INSERT OR REPLACE INTO indexer_state (token_mint, key, value, updated_at)
     VALUES (?, 'last_signature', ?, ?)`,
        [tokenMint, signature, Math.floor(Date.now() / 1000)]
    );
}

async function setLastProcessedAt(tokenMint, ts) {
    await db.run(
        `INSERT OR REPLACE INTO indexer_state (token_mint, key, value, updated_at)
     VALUES (?, 'last_processed_at', ?, ?)`,
        [tokenMint, String(ts), Math.floor(Date.now() / 1000)]
    );
}

async function incrementTotalTrades(tokenMint, count = 1) {
    const row = await db.get(
        `SELECT value FROM indexer_state WHERE token_mint = ? AND key = 'total_trades'`,
        [tokenMint]
    );
    const current = parseInt(row?.value || '0', 10);
    await db.run(
        `INSERT OR REPLACE INTO indexer_state (token_mint, key, value, updated_at)
     VALUES (?, 'total_trades', ?, ?)`,
        [tokenMint, String(current + count), Math.floor(Date.now() / 1000)]
    );
}

async function getStateForMint(tokenMint) {
    const rows = await db.all(
        `SELECT key, value FROM indexer_state WHERE token_mint = ?`,
        [tokenMint]
    );
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

async function getAllMintStates() {
    const rows = await db.all(
        `SELECT token_mint, key, value FROM indexer_state ORDER BY token_mint`
    );
    const result = {};
    for (const r of rows) {
        if (!result[r.token_mint]) result[r.token_mint] = {};
        result[r.token_mint][r.key] = r.value;
    }
    return result;
}

module.exports = {
    ensureMintState,
    getLastSignature,
    setLastSignature,
    setLastProcessedAt,
    incrementTotalTrades,
    getStateForMint,
    getAllMintStates,
};
