'use strict';
/**
 * Poller — per-mint instance managed by PollerManager.
 *
 * Usage:
 *   const mgr = require('./pollerManager');
 *   mgr.start(tokenMint);   // start indexing
 *   mgr.stop(tokenMint);    // stop
 *   mgr.list();             // active mints
 */

require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const db = require('../db');
const logger = require('../logger');
const { parseTradeFromLogs } = require('./parser');
const {
    ensureMintState,
    getLastSignature,
    setLastSignature,
    setLastProcessedAt,
    incrementTotalTrades,
} = require('./state');
const { upsertCandlesForTrade } = require('../services/candleService');
const { emitCandle, emitPrice } = require('../services/broadcaster');
const { RESOLUTIONS } = require('../services/candleService');

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PROGRAM_ID = process.env.PROGRAM_ID;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '10', 10);
const MAX_SIGNATURES = parseInt(process.env.MAX_SIGNATURES || '1000', 10);
const INTER_BATCH_DELAY = parseInt(process.env.INTER_BATCH_DELAY_MS || '300', 10);

// Shared connection — one RPC connection for all mints
let _connection = null;
function getConnection() {
    if (!_connection) {
        _connection = new Connection(RPC_URL, { commitment: 'confirmed' });
    }
    return _connection;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, { maxAttempts = 6, baseDelayMs = 500 } = {}) {
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (err) {
            attempt++;
            const is429 = err?.message?.includes('429') || err?.message?.includes('rate limit');
            const delayMs = Math.min(baseDelayMs * Math.pow(2, attempt - 1), 30_000);
            if (attempt >= maxAttempts) throw err;
            logger.warn(`[poller] retry ${attempt}/${maxAttempts}${is429 ? ' (429)' : ''} in ${delayMs}ms: ${err.message}`);
            await sleep(delayMs);
        }
    }
}

async function signatureExists(signature) {
    const row = await db.get(`SELECT id FROM trades WHERE signature = ?`, [signature]);
    return !!row;
}

async function storeTrade(trade) {
    try {
        await db.run(
            `INSERT INTO trades (token_mint, signature, timestamp, price, token_amount, sol_amount, side, trader)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [trade.token_mint, trade.signature, trade.timestamp, trade.price, trade.tokenAmount, trade.solAmount, trade.side, trade.trader || null]
        );
        return true;
    } catch (err) {
        if (err.message?.includes('UNIQUE') || err.code === '23505') return false;
        throw err;
    }
}

// ─── Single-mint poll tick ────────────────────────────────────────────────────

async function pollOnce(tokenMint, bondingCurvePDA) {
    const connection = getConnection();
    const lastSig = await getLastSignature(tokenMint);

    const signaturesRaw = await withRetry(() =>
        connection.getSignaturesForAddress(bondingCurvePDA, {
            limit: MAX_SIGNATURES,
            ...(lastSig ? { until: lastSig } : {}),
        })
    );

    if (signaturesRaw.length === 0) {
        logger.debug(`[poller:${tokenMint.slice(0, 8)}] No new signatures`);
        return;
    }

    logger.info(`[poller:${tokenMint.slice(0, 8)}] ${signaturesRaw.length} new signature(s)`);

    const signatures = [...signaturesRaw].reverse(); // oldest first
    let newTradeCount = 0;

    for (let i = 0; i < signatures.length; i += BATCH_SIZE) {
        const batch = signatures.slice(i, i + BATCH_SIZE);
        const sigStrings = batch.map(s => s.signature);

        const txs = [];
        for (const sig of sigStrings) {
            try {
                const tx = await withRetry(() =>
                    connection.getParsedTransaction(sig, {
                        maxSupportedTransactionVersion: 0,
                        commitment: 'confirmed',
                    })
                );
                txs.push(tx);
            } catch (err) {
                logger.error(`[poller:${tokenMint.slice(0, 8)}] tx fetch error for ${sig.slice(0, 8)}: ${err.message}`);
                txs.push(null);
            }
            await sleep(INTER_BATCH_DELAY); // pace requests
        }

        for (let j = 0; j < txs.length; j++) {
            const tx = txs[j];
            const sig = sigStrings[j];

            if (!tx?.blockTime || !tx.meta?.logMessages) continue;

            const trade = parseTradeFromLogs(tx.meta.logMessages, tx.blockTime, sig, tx);
            if (!trade) {
                logger.debug(`[poller] No trade parsed from sig ${sig.slice(0, 8)}`);
                continue;
            }

            if (await signatureExists(sig)) continue;

            // Attach token_mint to the trade record
            trade.token_mint = tokenMint;

            const stored = await storeTrade(trade);
            if (!stored) continue;

            newTradeCount++;

            await upsertCandlesForTrade(trade);

            // Broadcast updates
            emitPrice({ mint: tokenMint, price: trade.price, timestamp: trade.timestamp });

            for (const [res, intervalMs] of Object.entries(RESOLUTIONS)) {
                const openTime = Math.floor(trade.timestamp * 1000 / intervalMs) * intervalMs;
                emitCandle({ mint: tokenMint, resolution: res, time: openTime, price: trade.price, volume: trade.tokenAmount });
            }

            logger.info(`[poller:${tokenMint.slice(0, 8)}] [${trade.side.toUpperCase()}] price=${trade.price.toFixed(12)} sol=${trade.solAmount.toFixed(6)} sig=${sig.slice(0, 8)}…`);
        }

        if (i + BATCH_SIZE < signatures.length) {
            await sleep(INTER_BATCH_DELAY);
        }
    }

    // Always advance the cursor to the newest signature returned
    await setLastSignature(tokenMint, signaturesRaw[0].signature);

    if (newTradeCount > 0) {
        await incrementTotalTrades(tokenMint, newTradeCount);
        await setLastProcessedAt(tokenMint, Math.floor(Date.now() / 1000));
        logger.info(`[poller:${tokenMint.slice(0, 8)}] ✅ ${newTradeCount} new trade(s)`);
    }
}

// ─── PollerManager — manages one timer per mint ───────────────────────────────

class PollerManager {
    constructor() {
        // tokenMint → { timer, pda }
        this._pollers = new Map();
    }

    /**
     * Start indexing a tokenMint. Idempotent — calling twice is safe.
     * @param {string} tokenMint  - base58 public key
     * @param {string} [programId] - override env PROGRAM_ID
     */
    async start(tokenMint, programId) {
        if (this._pollers.has(tokenMint)) {
            logger.info(`[manager] Already indexing ${tokenMint.slice(0, 8)}`);
            return;
        }

        const pid = programId || PROGRAM_ID;
        if (!pid) throw new Error('PROGRAM_ID must be set (env or payload)');

        let bondingCurvePDA;
        try {
            [bondingCurvePDA] = PublicKey.findProgramAddressSync(
                [Buffer.from('bonding_curve'), new PublicKey(tokenMint).toBuffer()],
                new PublicKey(pid)
            );

            logger.info(`[manager] Querying PDA: ${bondingCurvePDA.toString()} for mint: ${tokenMint}`);
        } catch (err) {
            throw new Error(`Invalid tokenMint or programId: ${err.message}`);
        }

        // Init DB state rows for this mint
        await ensureMintState(tokenMint);

        logger.info(`[manager] Starting poller for ${tokenMint} (PDA: ${bondingCurvePDA.toString()})`);

        let running = true;
        let timerId = null;

        const loop = async () => {
            if (!running) return;
            try {
                await pollOnce(tokenMint, bondingCurvePDA);
            } catch (err) {
                logger.error(`[poller:${tokenMint.slice(0, 8)}] Unhandled error: ${err.message}`);
            }
            if (running) {
                timerId = setTimeout(loop, POLL_INTERVAL_MS);
            }
        };

        this._pollers.set(tokenMint, {
            stop: () => {
                running = false;
                if (timerId) clearTimeout(timerId);
                logger.info(`[manager] Stopped poller for ${tokenMint.slice(0, 8)}`);
            },
            pda: bondingCurvePDA.toString(),
            programId: pid,
            startedAt: Math.floor(Date.now() / 1000),
        });

        loop(); // fire immediately, don't await — poll runs in background
    }

    stop(tokenMint) {
        const entry = this._pollers.get(tokenMint);
        if (!entry) return false;
        entry.stop();
        this._pollers.delete(tokenMint);
        return true;
    }

    stopAll() {
        for (const [mint, entry] of this._pollers) {
            entry.stop();
        }
        this._pollers.clear();
    }

    list() {
        const result = [];
        for (const [mint, entry] of this._pollers) {
            result.push({
                tokenMint: mint,
                pda: entry.pda,
                programId: entry.programId,
                startedAt: entry.startedAt,
            });
        }
        return result;
    }

    isActive(tokenMint) {
        return this._pollers.has(tokenMint);
    }
}

module.exports = new PollerManager();
