'use strict';
/**
 * WebSocket broadcaster — push candle updates and price ticks to all clients.
 *
 * Usage:
 *   const broadcaster = require('./broadcaster');
 *   broadcaster.init(wss);          // call once from server.js
 *   broadcaster.emitCandle(data);   // call from poller
 *   broadcaster.emitPrice(data);    // call from poller
 */

const logger = require('../logger');

let _wss = null;

function init(wss) {
    _wss = wss;
    logger.info('[broadcaster] WebSocket broadcaster ready');
}

/**
 * Broadcast a JSON message to every connected WebSocket client.
 * @param {string} event   - event name
 * @param {any}    payload - data to send
 */
function broadcast(event, payload) {
    if (!_wss) return;

    const message = JSON.stringify({ event, data: payload });

    let count = 0;
    _wss.clients.forEach(client => {
        // WebSocket.OPEN === 1
        if (client.readyState === 1) {
            client.send(message, err => {
                if (err) logger.warn(`[broadcaster] send error: ${err.message}`);
            });
            count++;
        }
    });

    if (count > 0) {
        logger.debug(`[broadcaster] "${event}" → ${count} client(s)`);
    }
}

/**
 * Emit a candle update (called after each trade is processed).
 * @param {{ resolution, time, open, high, low, close, volume }} candle
 */
function emitCandle(candle) {
    broadcast('candle_update', candle);
}

/**
 * Emit a latest-price update.
 * @param {{ price, timestamp }} priceData
 */
function emitPrice(priceData) {
    broadcast('price_update', priceData);
}

module.exports = { init, broadcast, emitCandle, emitPrice };
