import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database/database.js";

describe("migración de esquema para bases de datos existentes", () => {
  let dir: string;
  let file: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tt-migration-")); file = join(dir, "old.sqlite"); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reconstruye la tabla signals cuando trae el UNIQUE viejo (source, chat, message) sin leg_index", () => {
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE signals (
        id TEXT PRIMARY KEY, telegram_chat_id TEXT NOT NULL, telegram_message_id TEXT NOT NULL,
        source TEXT NOT NULL, chat_name TEXT NOT NULL, original_message TEXT NOT NULL,
        ai_result_json TEXT, validation_result_json TEXT, symbol TEXT, side TEXT, entry TEXT,
        entry_min TEXT, entry_max TEXT, stop_loss TEXT, take_profit TEXT, requested_lot TEXT,
        approved_lot TEXT, risk_percentage TEXT, confidence REAL, received_at TEXT NOT NULL,
        analyzed_at TEXT, validated_at TEXT, expires_at TEXT NOT NULL, status TEXT NOT NULL,
        rejection_code TEXT, rejection_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        UNIQUE(source, telegram_chat_id, telegram_message_id)
      );
    `);
    legacy.prepare(`INSERT INTO signals(
      id,telegram_chat_id,telegram_message_id,source,chat_name,original_message,
      received_at,expires_at,status,created_at,updated_at
    ) VALUES('SIG-OLD-1','1','1','TELEGRAM','test','hi','2026-01-01T00:00:00.000Z','2026-01-01T00:10:00.000Z','QUEUED','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
    legacy.close();

    const db = openDatabase(file);
    const row = db.prepare("SELECT signal_group_id,leg_index,leg_count FROM signals WHERE id='SIG-OLD-1'").get() as
      { signal_group_id: string; leg_index: number; leg_count: number };
    expect(row).toEqual({ signal_group_id: "SIG-OLD-1", leg_index: 0, leg_count: 1 });

    // Ahora ya puede insertar una pierna hermana (leg_index=1) para el mismo mensaje de Telegram,
    // algo que el UNIQUE viejo habría rechazado.
    const timestamp = new Date().toISOString();
    expect(() => db.prepare(`INSERT INTO signals(
      id,telegram_chat_id,telegram_message_id,source,chat_name,original_message,
      received_at,expires_at,status,created_at,updated_at,signal_group_id,leg_index,leg_count
    ) VALUES('SIG-OLD-1-TP2','1','1','TELEGRAM','test','hi',?,?,'QUEUED',?,?,'SIG-OLD-1',1,2)`)
      .run(timestamp, timestamp, timestamp, timestamp)).not.toThrow();
    db.close();
  });

  it("no toca nada si la base ya usa el esquema nuevo", () => {
    const db = openDatabase(file);
    db.close();
    // Reabrir no debe fallar ni duplicar la migración de reconstrucción.
    const reopened = openDatabase(file);
    const migrations = reopened.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
    expect(migrations.map((m) => m.version)).toEqual([1, 2, 3]);
    reopened.close();
  });
});
