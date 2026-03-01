'use strict';
/**
 * Fetch the list of token mints to index from the Noottools panel API.
 *
 * API: https://panel.noottools.io/items/projects?sort=-date_created
 * Only Solana projects with a valid contract_address are returned.
 *
 * Returns an array of:
 *   { label: string, tokenMint: string }
 */

const logger = require('../logger');

const PANEL_API_URL =
    process.env.PANEL_API_URL ||
    'https://panel.noottools.io/items/projects?sort=-date_created';

/**
 * Fetch mints from the Noottools panel and normalise to {label, tokenMint}.
 * Falls back to an empty array on network/parse errors.
 *
 * @returns {Promise<Array<{label: string, tokenMint: string}>>}
 */
async function fetchMints() {
    let resp;
    try {
        resp = await fetch(PANEL_API_URL);
    } catch (err) {
        logger.error(`[mints] Failed to reach panel API: ${err.message}`);
        return [];
    }

    if (!resp.ok) {
        logger.error(`[mints] Panel API returned ${resp.status} ${resp.statusText}`);
        return [];
    }

    let body;
    try {
        body = await resp.json();
    } catch (err) {
        logger.error(`[mints] Failed to parse panel API response: ${err.message}`);
        return [];
    }

    const projects = Array.isArray(body?.data) ? body.data : [];

    const mints = projects
        .filter(p =>
            p.status === 'published' &&
            p.chain === 'solana' &&
            typeof p.contract_address === 'string' &&
            p.contract_address.length > 0
        )
        .map(p => ({
            label: p.name || p.symbol || p.contract_address.slice(0, 8),
            tokenMint: p.contract_address,
        }));

    logger.info(`[mints] Fetched ${mints.length} Solana mint(s) from panel API`);
    return mints;
}

module.exports = { fetchMints };
