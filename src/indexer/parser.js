'use strict';
/**
 * Parse raw on-chain log messages into a structured trade object.
 *
 * Expected log patterns (from the on-chain program):
 *   Buy:  "Buy: 5000000000 SOL for 1234567890 tokens"
 *   Sell: "Sell: 1234567890 tokens for 5000000000 SOL"
 *
 * All amounts are in lamports / base token units (1e9 per SOL/token).
 */

const BUY_REGEX = /Buy:\s*(\d+)\s*SOL\s*for\s*(\d+)\s*tokens/i;
const SELL_REGEX = /Sell:\s*(\d+)\s*tokens\s*for\s*(\d+)\s*SOL/i;

/**
 * Extract the trader (fee payer / first signer) from a parsed transaction.
 * @param {object} tx - result of connection.getParsedTransaction()
 * @returns {string|null}
 */
function extractTrader(tx) {
    try {
        const keys = tx?.transaction?.message?.accountKeys;
        if (!keys || keys.length === 0) return null;
        // First account key is the fee payer / signer
        const first = keys[0];
        // getParsedTransaction returns objects with a `.pubkey` property
        if (first?.pubkey) return first.pubkey.toString();
        // getTransaction returns PublicKey objects directly
        if (typeof first?.toBase58 === 'function') return first.toBase58();
        return String(first);
    } catch {
        return null;
    }
}

/**
 * @param {string[]} logMessages  - tx.meta.logMessages
 * @param {number}   blockTime    - Unix seconds
 * @param {string}   signature    - transaction signature
 * @param {object}   tx           - full transaction object for trader extraction
 * @returns {{ signature, timestamp, price, tokenAmount, solAmount, side, trader } | null}
 */
function parseTradeFromLogs(logMessages, blockTime, signature, tx = null) {
    if (!logMessages || !blockTime) return null;

    const trader = tx ? extractTrader(tx) : null;

    for (const log of logMessages) {
        // ─── Buy ─────────────────────────────────────────────────────────────────
        const buyMatch = log.match(BUY_REGEX);
        if (buyMatch) {
            const solLamports = parseInt(buyMatch[1], 10);
            const tokenUnits = parseInt(buyMatch[2], 10);

            if (tokenUnits === 0) continue; // guard div-by-zero

            return {
                signature,
                timestamp: blockTime,                 // Unix seconds
                price: solLamports / tokenUnits,      // lamports-per-token-unit (raw)
                tokenAmount: tokenUnits / 1e9,         // human-readable tokens
                solAmount: solLamports / 1e9,          // human-readable SOL
                side: 'buy',
                trader,
            };
        }

        // ─── Sell ────────────────────────────────────────────────────────────────
        const sellMatch = log.match(SELL_REGEX);
        if (sellMatch) {
            const tokenUnits = parseInt(sellMatch[1], 10);
            const solLamports = parseInt(sellMatch[2], 10);

            if (tokenUnits === 0) continue;

            return {
                signature,
                timestamp: blockTime,
                price: solLamports / tokenUnits,
                tokenAmount: tokenUnits / 1e9,
                solAmount: solLamports / 1e9,
                side: 'sell',
                trader,
            };
        }
    }

    return null; // not a trade transaction
}

module.exports = { parseTradeFromLogs };
