-- ─────────────────────────────────────────────────────────────────────────────
-- trades: raw on-chain swap events (scoped per token mint)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trades (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  token_mint      TEXT    NOT NULL,
  signature       TEXT    NOT NULL UNIQUE,
  timestamp       INTEGER NOT NULL,
  price           REAL    NOT NULL,
  token_amount    REAL    NOT NULL,
  sol_amount      REAL    NOT NULL,
  side            TEXT    NOT NULL CHECK (side IN ('buy','sell')),
  trader          TEXT,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_trades_mint_ts  ON trades (token_mint, timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_side     ON trades (side);

-- ─────────────────────────────────────────────────────────────────────────────
-- candles: pre-aggregated OHLCV (scoped per token mint + resolution)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS candles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_mint  TEXT    NOT NULL,
  resolution  TEXT    NOT NULL,
  open_time   INTEGER NOT NULL,
  open        REAL    NOT NULL,
  high        REAL    NOT NULL,
  low         REAL    NOT NULL,
  close       REAL    NOT NULL,
  volume      REAL    NOT NULL DEFAULT 0,
  trade_count INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_candles_mint_res_time ON candles (token_mint, resolution, open_time);
CREATE INDEX        IF NOT EXISTS idx_candles_mint_res      ON candles (token_mint, resolution);

-- ─────────────────────────────────────────────────────────────────────────────
-- indexer_state: per-mint state (last processed signature, etc.)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS indexer_state (
  token_mint  TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  value       TEXT,
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (token_mint, key)
);
