import initSqlJs, { type Database } from 'sql.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GringoError } from './errors/gringoError';
import { log } from './utils/logger';
import type { DbConfig } from './config/types';

const dbLog = log.withScope('db');

let dbSingleton: Database | null = null;
let dbPath: string = '';

export async function initDb(config: DbConfig): Promise<Database> {
  if (dbSingleton) {
    dbLog.warn('Database already initialized, returning existing instance');
    return dbSingleton;
  }

  try {
    dbPath = config.path;

    // Ensure data directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      dbLog.info(`Created data directory: ${dir}`);
    }

    // Initialize sql.js
    const SQL = await initSqlJs();

    // Load existing database or create new one
    let db: Database;
    if (fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      db = new SQL.Database(fileBuffer);
      dbLog.info(`Loaded existing database from ${dbPath}`);
    } else {
      db = new SQL.Database();
      dbLog.info(`Created new database at ${dbPath}`);
    }

    // Enable foreign key enforcement (before schema so FK constraints are checked during creation)
    db.exec('PRAGMA foreign_keys = ON');

    // Apply schema
    const schemaPath = path.join(__dirname, 'db', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    db.exec(schema);

    // Re-enable foreign keys (multi-statement exec can reset connection pragmas)
    db.exec('PRAGMA foreign_keys = ON');

    // ── Column migrations (safe to re-run) ────────────────────
    const addColumnIfMissing = (table: string, column: string, definition: string) => {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        dbLog.info(`Added column ${table}.${column}`);
      } catch {
        // Column already exists — expected on subsequent runs
      }
    };
    addColumnIfMissing('users', 'response_mode', "TEXT NOT NULL DEFAULT 'text'");
    addColumnIfMissing('user_curriculum_progress', 'lesson_text', 'TEXT');
    addColumnIfMissing('user_curriculum_progress', 'exercise_text', 'TEXT');

    const result = db.exec(
      "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence'",
    );
    const tableCount = result[0]?.values[0]?.[0] ?? 0;

    dbLog.info(`Schema applied — ${tableCount} tables ready`);

    dbSingleton = db;

    // Save to disk after schema application
    saveDb();

    return db;
  } catch (err) {
    throw new GringoError({
      message: `Failed to initialize database: ${err instanceof Error ? err.message : String(err)}`,
      code: 'ERR_DB_INIT',
      cause: err,
      metadata: { path: config.path },
    });
  }
}

export function getDb(): Database {
  if (!dbSingleton) {
    throw new GringoError({
      message: 'Database not initialized. Call initDb() first.',
      code: 'ERR_DB_INIT',
    });
  }
  return dbSingleton;
}

export function saveDb(): void {
  if (dbSingleton && dbPath) {
    const data = dbSingleton.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
    // db.export() resets connection pragmas — re-enable foreign keys
    dbSingleton.exec('PRAGMA foreign_keys = ON');
    dbLog.debug('Database saved to disk');
  }
}

export function closeDb(): void {
  if (dbSingleton) {
    saveDb();
    dbSingleton.close();
    dbSingleton = null;
    dbLog.info('Database saved and connection closed');
  }
}
