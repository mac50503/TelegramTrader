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
  db.exec(schemaSql);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?)").run(new Date().toISOString());
  const signalColumns = new Set((db.prepare("PRAGMA table_info(signals)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!signalColumns.has("entry_min")) db.exec("ALTER TABLE signals ADD COLUMN entry_min TEXT");
  if (!signalColumns.has("entry_max")) db.exec("ALTER TABLE signals ADD COLUMN entry_max TEXT");
  db.prepare("UPDATE signals SET entry_min=COALESCE(entry_min,entry),entry_max=COALESCE(entry_max,entry) WHERE entry IS NOT NULL").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(2, ?)").run(new Date().toISOString());
  return db;
}
