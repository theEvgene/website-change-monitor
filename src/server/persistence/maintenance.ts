import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { applicationPaths } from "../operations/paths.js";
import { latestSchemaVersion } from "./schema-version.js";

export interface IntegrityReport { quickCheck: "ok"; foreignKeyViolations: 0 }
export interface RestoreOptions { verify?: (path: string) => IntegrityReport }

export function verifyDatabaseFile(path: string): IntegrityReport {
  const database = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try {
    const quick = database.pragma("quick_check") as Array<{ quick_check: string }>;
    if (quick.length !== 1 || quick[0]?.quick_check !== "ok") throw new Error("SQLite quick_check обнаружил повреждение базы данных.");
    database.pragma("foreign_keys = ON");
    const foreignKeys = database.pragma("foreign_key_check") as unknown[];
    if (foreignKeys.length !== 0) throw new Error("SQLite foreign_key_check обнаружил нарушение связей.");
    return { quickCheck: "ok", foreignKeyViolations: 0 };
  } finally { database.close(); }
}

export async function createManualBackup(rootDirectory: string, requestedPath?: string): Promise<string> {
  const paths = applicationPaths(rootDirectory);
  if (!existsSync(paths.database)) throw new Error("Основная база данных ещё не создана.");
  mkdirSync(paths.backups, { recursive: true });
  const destination = requestedPath === undefined
    ? join(paths.backups, `manual-${timestamp()}.sqlite3`)
    : resolveBackupPath(requestedPath, paths.backups);
  if (existsSync(destination)) throw new Error(`Копия уже существует: ${destination}`);
  const source = new BetterSqlite3(paths.database, { readonly: true, fileMustExist: true });
  try { await source.backup(destination); } finally { source.close(); }
  verifyDatabaseFile(destination);
  return destination;
}

export function restoreManualBackup(rootDirectory: string, sourcePath: string, options: RestoreOptions = {}): string {
  const paths = applicationPaths(rootDirectory);
  const verify = options.verify ?? verifyDatabaseFile;
  const source = resolve(sourcePath);
  if (!isAbsolute(source) || !existsSync(source)) throw new Error(`Копия не найдена: ${source}`);
  verify(source);
  assertCompatibleSchema(source);
  mkdirSync(paths.data, { recursive: true });
  const staged = join(paths.data, `.restore-${process.pid}-${Date.now()}.sqlite3`);
  const previous = `${paths.database}.restore-previous`;
  copyFileSync(source, staged);
  verify(staged);
  let previousMoved = false;
  try {
    rmSync(`${paths.database}-wal`, { force: true });
    rmSync(`${paths.database}-shm`, { force: true });
    if (existsSync(previous)) rmSync(previous, { force: true });
    if (existsSync(paths.database)) {
      renameSync(paths.database, previous);
      previousMoved = true;
    }
    renameSync(staged, paths.database);
    verify(paths.database);
    rmSync(previous, { force: true });
  } catch (error) {
    rmSync(staged, { force: true });
    if (previousMoved && existsSync(previous)) {
      rmSync(paths.database, { force: true });
      renameSync(previous, paths.database);
    }
    throw error;
  }
  return paths.database;
}

function assertCompatibleSchema(path: string): void {
  const database = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try {
    const table = database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_migrations'").get();
    if (table === undefined) throw new Error("Копия создана несовместимой версией приложения.");
    const row = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number };
    if (row.version > latestSchemaVersion) throw new Error("Копия создана более новой несовместимой версией приложения.");
  } finally { database.close(); }
}

function resolveBackupPath(value: string, backupDirectory: string): string {
  const result = isAbsolute(value) ? resolve(value) : resolve(backupDirectory, value);
  if (extname(result).toLowerCase() !== ".sqlite3") throw new Error("Имя копии должно оканчиваться на .sqlite3.");
  mkdirSync(dirname(result), { recursive: true });
  return result;
}

function timestamp(): string { return new Date().toISOString().replace(/[:.]/gu, "-"); }
