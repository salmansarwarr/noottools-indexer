'use strict';
/**
 * Database adapter — SQLite (default) or PostgreSQL.
 *
 * Exports a unified interface:
 *   db.run(sql, params)   → { changes, lastInsertRowid }
 *   db.get(sql, params)   → row | undefined
 *   db.all(sql, params)   → row[]
 *   db.close()
 *
 * SQLite uses synchronous better-sqlite3.
 * PostgreSQL uses async pg — all methods return Promises either way.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const logger = require('../logger');

const DB_TYPE = (process.env.DB_TYPE || 'sqlite').toLowerCase();

// ─── SQLite adapter ────────────────────────────────────────────────────────────
function buildSQLiteDb() {
    const Database = require('better-sqlite3');
    const dbPath = path.resolve(process.env.SQLITE_PATH || './data/indexer.db');

    // Ensure directory exists
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const raw = new Database(dbPath);
    raw.pragma('journal_mode = WAL');
    raw.pragma('synchronous = NORMAL');

    // Run schema — better-sqlite3 exec() handles multi-statement SQL natively
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    raw.exec(schema);

    logger.info(`[db] SQLite connected → ${dbPath}`);

    return {
        run(sql, params = []) {
            return Promise.resolve(raw.prepare(sql).run(...params));
        },
        get(sql, params = []) {
            return Promise.resolve(raw.prepare(sql).get(...params));
        },
        all(sql, params = []) {
            return Promise.resolve(raw.prepare(sql).all(...params));
        },
        close() {
            raw.close();
            return Promise.resolve();
        },
        // Expose raw for transactions
        transaction(fn) {
            return raw.transaction(fn);
        },
    };
}

// ─── PostgreSQL adapter ────────────────────────────────────────────────────────
function buildPgDb() {
    const { Pool } = require('pg');
    const pool = new Pool(process.env.SUPABASE_CONNECTION_URL ? {
        connectionString: process.env.SUPABASE_CONNECTION_URL,
        ssl: { rejectUnauthorized: false } // Supabase requires SSL usually, but rejectUnauthorized: false is common for dev/simplicity
    } : {
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT || '5432'),
        database: process.env.PG_DATABASE || 'bonding_indexer',
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || '',
    });

    // Adapter converts SQLite-style ? placeholders to $1 $2 … for PG,
    // and also does basic translation for common SQLite-isms like INSERT OR IGNORE.
    function pgSql(sql, params = []) {
        let translated = sql;

        // Simple INSERT OR IGNORE -> INSERT ... ON CONFLICT DO NOTHING
        if (/INSERT OR IGNORE/i.test(translated)) {
            translated = translated.replace(/INSERT OR IGNORE INTO (\w+)/i, (match, table) => {
                // This is a naive translation. For more complex queries it might need more logic.
                // We assume the caller handles the ON CONFLICT part or we append DO NOTHING.
                return `INSERT INTO ${table}`;
            });
            if (!/ON CONFLICT/i.test(translated)) {
                translated += ' ON CONFLICT DO NOTHING';
            }
        }

        // Simple INSERT OR REPLACE -> INSERT ... ON CONFLICT (...) DO UPDATE ...
        // Note: This is hacky because it requires knowing the unique constraint.
        // For indexer_state, the PK is (token_mint, key).
        if (/INSERT OR REPLACE/i.test(translated)) {
            if (/indexer_state/i.test(translated)) {
                translated = translated.replace(/INSERT OR REPLACE INTO indexer_state/i, 'INSERT INTO indexer_state');
                if (!/ON CONFLICT/i.test(translated)) {
                    translated += ' ON CONFLICT (token_mint, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at';
                }
            } else if (/trades/i.test(translated)) {
                translated = translated.replace(/INSERT OR REPLACE INTO trades/i, 'INSERT INTO trades');
                if (!/ON CONFLICT/i.test(translated)) {
                    translated += ' ON CONFLICT (signature) DO NOTHING'; // or update? Usually signatures don't change.
                }
            } else if (/candles/i.test(translated)) {
                translated = translated.replace(/INSERT OR REPLACE INTO candles/i, 'INSERT INTO candles');
                if (!/ON CONFLICT/i.test(translated)) {
                    translated += ' ON CONFLICT (token_mint, resolution, open_time) DO UPDATE SET open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, close=EXCLUDED.close, volume=EXCLUDED.volume, trade_count=EXCLUDED.trade_count, updated_at=EXCLUDED.updated_at';
                }
            }
        }

        let i = 0;
        return { text: translated.replace(/\?/g, () => `$${++i}`), values: params };
    }

    async function init() {
        // Convert SQLite schema to PG-compatible SQL (basic substitutions)
        let schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
        schema = schema
            .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
            .replace(/strftime\('%s','now'\)/gi, 'EXTRACT(EPOCH FROM NOW())::BIGINT')
            .replace(/INSERT OR IGNORE/gi, 'INSERT')
            .replace(/CREATE INDEX\s+IF NOT EXISTS/gi, 'CREATE INDEX IF NOT EXISTS')
            .replace(/CREATE UNIQUE INDEX\s+IF NOT EXISTS/gi, 'CREATE UNIQUE INDEX IF NOT EXISTS')
            .replace(/ON CONFLICT\s*DO\s*NOTHING/gi, 'ON CONFLICT DO NOTHING');

        const client = await pool.connect();
        try {
            await client.query(schema);
            logger.info('[db] PostgreSQL connected and schema applied');
        } finally {
            client.release();
        }
    }

    const ready = init().catch(err => {
        logger.error('[db] PostgreSQL init error: ' + err.message);
        process.exit(1);
    });

    return {
        async run(sql, params = []) {
            await ready;
            const res = await pool.query(pgSql(sql, params));
            return { changes: res.rowCount, lastInsertRowid: null };
        },
        async get(sql, params = []) {
            await ready;
            const res = await pool.query(pgSql(sql, params));
            return res.rows[0];
        },
        async all(sql, params = []) {
            await ready;
            const res = await pool.query(pgSql(sql, params));
            return res.rows;
        },
        async close() {
            await pool.end();
        },
        transaction(fn) {
            // Minimal transaction helper for PG — wrap in BEGIN/COMMIT
            return async (...args) => {
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    const result = await fn(...args);
                    await client.query('COMMIT');
                    return result;
                } catch (e) {
                    await client.query('ROLLBACK');
                    throw e;
                } finally {
                    client.release();
                }
            };
        },
    };
}

// ─── Export singleton ──────────────────────────────────────────────────────────
const db = DB_TYPE === 'postgres' ? buildPgDb() : buildSQLiteDb();
module.exports = db;
