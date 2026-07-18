import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { applicationPaths } from "../operations/paths.js";
import { latestSchemaVersion } from "./schema-version.js";

export interface IntegrityReport { quickCheck: "ok"; foreignKeyViolations: 0 }
export interface RestoreOptions { verify?: (path: string) => IntegrityReport }
export type AutomaticBackupKind = "pre-update" | "pre-migration";

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
  await backupDatabase(paths.database, destination);
  return destination;
}

export async function createAutomaticBackup(rootDirectory: string, kind: AutomaticBackupKind, protectedPaths: string[] = []): Promise<string> {
  const paths = applicationPaths(rootDirectory);
  if (!existsSync(paths.database)) throw new Error("Основная база данных ещё не создана.");
  mkdirSync(paths.backups, { recursive: true });
  const destination = join(paths.backups, `${kind}-${timestamp()}.sqlite3`);
  await backupDatabase(paths.database, destination);
  const matching = readdirSync(paths.backups, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${kind}-`) && entry.name.endsWith(".sqlite3"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const protectedNames = new Set(protectedPaths.map((path) => resolve(path)).filter((path) => dirname(path) === resolve(paths.backups)).map((path) => basename(path)));
  const keep = new Set(matching.slice(0, 3));
  for (const protectedName of protectedNames) {
    if (!matching.includes(protectedName) || keep.has(protectedName)) continue;
    const replaceable = [...keep].reverse().find((name) => !protectedNames.has(name));
    if (replaceable !== undefined) keep.delete(replaceable);
    keep.add(protectedName);
  }
  for (const expired of matching.filter((name) => !keep.has(name))) rmSync(join(paths.backups, expired), { force: true });
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

async function backupDatabase(sourcePath: string, destination: string): Promise<void> {
  if (existsSync(destination)) throw new Error(`Копия уже существует: ${destination}`);
  const source = new BetterSqlite3(sourcePath, { readonly: true, fileMustExist: true });
  try { await source.backup(destination); } finally { source.close(); }
  verifyDatabaseFile(destination);
  rmSync(`${destination}-wal`, { force: true });
  rmSync(`${destination}-shm`, { force: true });
}

function timestamp(): string { return new Date().toISOString().replace(/[:.]/gu, "-"); }
