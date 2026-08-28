export const schemaSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_counters (
  counter_date TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  telegram_chat_id TEXT NOT NULL,
  telegram_message_id TEXT NOT NULL,
  source TEXT NOT NULL,
  chat_name TEXT NOT NULL,
  original_message TEXT NOT NULL,
  ai_result_json TEXT,
  validation_result_json TEXT,
  symbol TEXT,
  side TEXT CHECK(side IN ('BUY', 'SELL') OR side IS NULL),
  entry TEXT,
  entry_min TEXT,
  entry_max TEXT,
  stop_loss TEXT,
  take_profit TEXT,
  requested_lot TEXT,
  approved_lot TEXT,
  risk_percentage TEXT,
  confidence REAL,
  received_at TEXT NOT NULL,
  analyzed_at TEXT,
  validated_at TEXT,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  rejection_code TEXT,
  rejection_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  signal_group_id TEXT,
  leg_index INTEGER NOT NULL DEFAULT 0,
  leg_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_signals_queue ON signals(status, received_at);
CREATE INDEX IF NOT EXISTS idx_signals_semantic ON signals(symbol, side, entry, stop_loss, take_profit, received_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_dedup ON signals(source, telegram_chat_id, telegram_message_id, leg_index);
CREATE INDEX IF NOT EXISTS idx_signals_group ON signals(signal_group_id);

CREATE TABLE IF NOT EXISTS signal_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id TEXT NOT NULL REFERENCES signals(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL UNIQUE REFERENCES signals(id),
  client_id TEXT NOT NULL,
  assignment_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  trading_mode TEXT NOT NULL CHECK(trading_mode IN ('SIMULATION', 'LIVE')),
  assigned_at TEXT NOT NULL,
  acknowledged_at TEXT,
  executed_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_trades_client_status ON trades(client_id, status);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL REFERENCES trades(id),
  request_id TEXT NOT NULL UNIQUE,
  result TEXT NOT NULL,
  mt5_order_ticket TEXT UNIQUE,
  mt5_deal_ticket TEXT UNIQUE,
  mt5_position_ticket TEXT UNIQUE,
  requested_price TEXT NOT NULL,
  execution_price TEXT,
  requested_volume TEXT NOT NULL,
  executed_volume TEXT,
  retcode TEXT,
  error_code TEXT,
  error_description TEXT,
  broker_response_json TEXT,
  executed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL UNIQUE REFERENCES trades(id),
  mt5_position_ticket TEXT UNIQUE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  volume TEXT NOT NULL,
  open_price TEXT NOT NULL,
  stop_loss TEXT NOT NULL,
  take_profit TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  close_price TEXT,
  gross_profit TEXT,
  commission TEXT,
  swap TEXT,
  net_profit TEXT,
  close_reason TEXT,
  closed_at TEXT,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mt5_clients (
  client_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  broker TEXT NOT NULL,
  currency TEXT NOT NULL,
  balance TEXT NOT NULL,
  equity TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  context_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(scope, key)
);

CREATE TABLE IF NOT EXISTS errors (
  id TEXT PRIMARY KEY,
  signal_id TEXT,
  trade_id TEXT,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  signal_id TEXT,
  trade_id TEXT,
  source TEXT,
  status TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
`;
