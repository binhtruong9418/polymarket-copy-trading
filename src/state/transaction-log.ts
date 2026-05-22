import Database from "better-sqlite3";
import type { LogEvent, EventType } from "../types/index.js";
import logger from "../utils/logger.js";

export class TransactionLog {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(dbPath = "bot-state.db") {
    this.db = new Database(dbPath);
    // WAL mode for durability without sacrificing write speed
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        type    TEXT    NOT NULL,
        payload TEXT    NOT NULL,
        ts      INTEGER NOT NULL
      )
    `);
    this.insertStmt = this.db.prepare(
      "INSERT INTO events (type, payload, ts) VALUES (?, ?, ?)",
    );
    logger.debug({ dbPath }, "Transaction log opened");
  }

  // Synchronous write — better-sqlite3 is sync, <1ms per insert
  append(type: EventType, payload: Record<string, unknown>): void {
    this.insertStmt.run(type, JSON.stringify(payload), Date.now());
  }

  readAll(): LogEvent[] {
    const rows = this.db
      .prepare("SELECT type, payload, ts FROM events ORDER BY id ASC")
      .all() as Array<{ type: string; payload: string; ts: number }>;

    return rows.map((r) => ({
      type: r.type as EventType,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      ts: r.ts,
    }));
  }

  close(): void {
    this.db.close();
  }
}
