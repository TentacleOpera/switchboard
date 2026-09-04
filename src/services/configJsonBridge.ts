import { KanbanDatabase } from './KanbanDatabase';

/**
 * config.json bridge — redirects legacy `.switchboard/config.json` reads/writes
 * to the kanban.db `config` table, modelled on stateConfigBridge.ts.
 *
 * The migration in KanbanDatabase._runConfigMigrations imports every key from
 * config.json as `config.<original-key>` (so `switchboard.theme.name` becomes
 * `config.switchboard.theme.name`). This bridge provides the read/write helpers
 * the HostPathConfigProvider implementations use, so existing call sites change
 * import target, not call shape.
 *
 * Sync reads on a not-yet-opened db return undefined (callers fall back to
 * env/vscode defaults); the extension and standalone bootstrap warm the db
 * before config reads happen.
 */

/**
 * Read a config.json value synchronously from the db config table.
 * Checks both `config.<key>` and `config.switchboard.<key>` (the two shapes
 * the file used to carry), returning the first hit.
 */
export function readConfigValueSync(workspaceRoot: string, key: string): unknown {
    const db = KanbanDatabase.forWorkspace(workspaceRoot);
    if (!db.isOpen()) return undefined;
    const direct = db.getConfigJsonSync<unknown>(`config.${key}`, undefined as unknown);
    if (direct !== undefined && direct !== null) return direct;
    const prefixed = db.getConfigJsonSync<unknown>(`config.switchboard.${key}`, undefined as unknown);
    if (prefixed !== undefined && prefixed !== null) return prefixed;
    return undefined;
}

/**
 * Write a config.json value to the db config table as `config.switchboard.<key>`.
 * Fire-and-forget on the sync path (mirrors stateConfigBridge's sync write),
 * awaited on the async path.
 */
export function writeConfigValueSync(workspaceRoot: string, key: string, value: unknown): void {
    const db = KanbanDatabase.forWorkspace(workspaceRoot);
    void db.ensureReady()
        .then(() => db.setConfigJson(`config.switchboard.${key}`, value))
        .catch((err: unknown) => console.error('[configJsonBridge] Sync config write failed:', err));
}

export async function writeConfigValue(workspaceRoot: string, key: string, value: unknown): Promise<void> {
    const db = KanbanDatabase.forWorkspace(workspaceRoot);
    await db.ensureReady();
    await db.setConfigJson(`config.switchboard.${key}`, value);
}

/**
 * Read the entire config.json object from the db — every key starting with
 * `config.` is returned with the `config.` prefix stripped. Used by direct
 * file readers (themeBodyClass, planIngestionHost) that need the whole object.
 */
export function readAllConfigSync(workspaceRoot: string): Record<string, unknown> {
    const db = KanbanDatabase.forWorkspace(workspaceRoot);
    if (!db.isOpen()) return {};
    const all = db.getAllConfigSync();
    const result: Record<string, unknown> = {};
    for (const { key, value } of all) {
        if (key.startsWith('config.')) {
            const stripped = key.slice('config.'.length);
            if (stripped) {
                try {
                    result[stripped] = JSON.parse(value);
                } catch {
                    result[stripped] = value;
                }
            }
        }
    }
    return result;
}
