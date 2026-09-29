import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { schemaSql } from "./schema.js";

export type SqliteDatabase = Database.Database;

function rebuildSignalsWithLegacyUnique(db: SqliteDatabase): void {
  const indexes = db.prepare("SELECT name, origin FROM pragma_index_list('signals')").all() as
    Array<{ name: string; origin: string }>;
  const legacyUnique = indexes.some((index) => index.origin === "u" &&
    (db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(index.name) as Array<{ name: string }>)
      .map((column) => column.name).join(",") === "source,telegram_chat_id,telegram_message_id");
  if (!legacyUnique) return;

  const createSql = /CREATE TABLE IF NOT EXISTS signals \([\s\S]*?\n\);/.exec(schemaSql)?.[0];
  if (!createSql) throw new Error("signals table definition is missing from schema");
  // Drop the old table without renaming it: SQLite otherwise rewrites child
  // foreign keys to point at the temporary name. Recreate indexes via schemaSql.
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(createSql.replace("CREATE TABLE IF NOT EXISTS signals", "CREATE TABLE signals_rebuild"));
      const columns = (db.prepare("PRAGMA table_info(signals_rebuild)").all() as Array<{ name: string }>)
        .map((column) => `"${column.name}"`).join(",");
      db.exec(`INSERT INTO signals_rebuild (${columns}) SELECT ${columns} FROM signals`);
      db.exec("DROP TABLE signals; ALTER TABLE signals_rebuild RENAME TO signals");
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

export function openDatabase(databaseUrl: string): SqliteDatabase {
  const filename = databaseUrl === ":memory:" ? databaseUrl : resolve(databaseUrl);
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  if (filename !== ":memory:") db.pragma("journal_mode = WAL");

  // Upgrade existing databases in place. Rebuilding the signals table would rewrite
  // foreign-key references in trades/positions to a temporary table and can make the
  // migration fail (or orphan historical trades). Adding nullable columns is compatible
  // with both legacy and current schemas and preserves all existing foreign keys.
  const signalColumns = new Set((db.prepare("PRAGMA table_info(signals)").all() as Array<{ name: string }>).map((column) => column.name));
  if (signalColumns.size > 0) {
    if (!signalColumns.has("entry_min")) db.exec("ALTER TABLE signals ADD COLUMN entry_min TEXT");
    if (!signalColumns.has("entry_max")) db.exec("ALTER TABLE signals ADD COLUMN entry_max TEXT");
    if (!signalColumns.has("signal_group_id")) db.exec("ALTER TABLE signals ADD COLUMN signal_group_id TEXT");
    if (!signalColumns.has("leg_index")) db.exec("ALTER TABLE signals ADD COLUMN leg_index INTEGER NOT NULL DEFAULT 0");
    if (!signalColumns.has("leg_count")) db.exec("ALTER TABLE signals ADD COLUMN leg_count INTEGER NOT NULL DEFAULT 1");
    rebuildSignalsWithLegacyUnique(db);
  }
  db.exec(schemaSql);
  db.prepare("UPDATE signals SET signal_group_id=COALESCE(signal_group_id,id), leg_index=COALESCE(leg_index,0), leg_count=COALESCE(leg_count,1)").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?)").run(new Date().toISOString());
  db.prepare("UPDATE signals SET entry_min=COALESCE(entry_min,entry),entry_max=COALESCE(entry_max,entry) WHERE entry IS NOT NULL").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(2, ?)").run(new Date().toISOString());

  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(3, ?)").run(new Date().toISOString());
  return db;
}
