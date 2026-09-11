/**
 * Store target resolution.
 *
 * There is ONE target: a local better-sqlite3 file. libSQL was rejected as a
 * direction on 2026-09-11 — the product is a Raspberry Pi appliance with one
 * board host and one store, and other machines reach it over HTTP rather than
 * replicating it. `libSqlDriver.ts` and the `libsql` dependency are deleted with
 * that decision; see the REJECTED note at the top of
 * `.switchboard/plans/libsql-shared-store-turso-and-self-hosted-sqld.md`.
 *
 * This module is kept rather than inlined because `openDriver` is the single
 * place a driver is constructed (`KanbanDatabase` calls it twice), and a future
 * binding change wants one seam rather than two call sites.
 *
 * It also kept the BUILD broken: `libsql` was a declared dependency that was
 * never installed, so webpack could not resolve the lazy `require` and every
 * bundle failed. A rejected technology must not stay wired in — that is the same
 * shape as the board mirrors and the DuckDB archive removed the same day.
 */

import { BetterSqliteDriver, ISqliteDriver, SqliteDriverOptions } from './sqliteDriver';

export type StoreTargetKind = 'local-file';

export interface StoreTarget {
    kind: StoreTargetKind;
}

/** The only target. Retained as a function so callers keep one shape. */
export function resolveStoreTarget(): StoreTarget {
    return { kind: 'local-file' };
}

/**
 * Open a database driver for the given path.
 *
 * The single construction seam for the board store.
 */
export function openDriver(dbPath: string, options?: SqliteDriverOptions): ISqliteDriver {
    return new BetterSqliteDriver(dbPath, options);
}
