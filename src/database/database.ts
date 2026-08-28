import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { schemaSql } from "./schema.js";

export type SqliteDatabase = Database.Database;

export function openDatabase(databaseUrl: string): SqliteDatabase {
  const filename = databaseUrl === ":memory:" ? databaseUrl : resolve(databaseUrl);
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  if (filename !== ":memory:") db.pragma("journal_mode = WAL");

  // schemaSql's CREATE INDEX statements reference leg_index/signal_group_id, which only exist on
  // a freshly created "signals" table. On an existing DB the old inline UNIQUE(source, chat, message)
  // constraint must be rebuilt away first (ALTER TABLE can't drop an inline UNIQUE), so rename the
  // legacy table out of the way before schemaSql runs and recreates "signals" with the new columns.
  const legacySignalsSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='signals'").get() as { sql: string } | undefined)?.sql ?? "";
  const needsSignalsRebuild = legacySignalsSql.includes("UNIQUE(source, telegram_chat_id, telegram_message_id)");
  if (needsSignalsRebuild) {
    db.pragma("foreign_keys = OFF");
    db.exec("ALTER TABLE signals RENAME TO signals_old_v2");
  }

  db.exec(schemaSql);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?)").run(new Date().toISOString());
  const signalColumns = new Set((db.prepare("PRAGMA table_info(signals)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!signalColumns.has("entry_min")) db.exec("ALTER TABLE signals ADD COLUMN entry_min TEXT");
  if (!signalColumns.has("entry_max")) db.exec("ALTER TABLE signals ADD COLUMN entry_max TEXT");
  db.prepare("UPDATE signals SET entry_min=COALESCE(entry_min,entry),entry_max=COALESCE(entry_max,entry) WHERE entry IS NOT NULL").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(2, ?)").run(new Date().toISOString());

  if (needsSignalsRebuild) {
    db.transaction(() => {
      db.exec(`INSERT INTO signals(
        id,telegram_chat_id,telegram_message_id,source,chat_name,original_message,ai_result_json,validation_result_json,
        symbol,side,entry,entry_min,entry_max,stop_loss,take_profit,requested_lot,approved_lot,risk_percentage,confidence,
        received_at,analyzed_at,validated_at,expires_at,status,rejection_code,rejection_reason,created_at,updated_at,version,
        signal_group_id,leg_index,leg_count)
        SELECT id,telegram_chat_id,telegram_message_id,source,chat_name,original_message,ai_result_json,validation_result_json,
        symbol,side,entry,entry_min,entry_max,stop_loss,take_profit,requested_lot,approved_lot,risk_percentage,confidence,
        received_at,analyzed_at,validated_at,expires_at,status,rejection_code,rejection_reason,created_at,updated_at,version,
        id,0,1
        FROM signals_old_v2`);
      db.exec("DROP TABLE signals_old_v2");
    })();
    db.pragma("foreign_keys = ON");
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(3, ?)").run(new Date().toISOString());
  return db;
}
