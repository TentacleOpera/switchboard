import * as vscode from 'vscode';
import { KanbanDatabase } from './KanbanDatabase';

/**
 * SettingsSyncService — optional one-way mirror of VS Code extension settings
 * into the active workspace `kanban.db` `config` table (key prefix `setting.*`).
 *
 * Scope: Workspace-targeted `switchboard.*` settings only. Global and
 * WorkspaceFolder settings are intentionally NOT synced (a global toggle would
 * desync across workspaces; a per-folder setting would leak into the wrong
 * workspace's DB).
 *
 * Primary sync mechanism is the `onDidChangeConfiguration` listener (catch-all
 * for changes made via the VS Code Settings UI). The `updateSetting` wrapper is
 * a convenience for in-process call sites and is redundant with the listener —
 * both paths converge on `syncToDb`.
 *
 * Default OFF (opt-in) to avoid surprise writes to existing users' shared DBs.
 */

const SETTING_KEY_PREFIX = 'setting.';
const DBSYNC_TOGGLE_KEY = 'settings.dbSyncEnabled';

/**
 * Hardcoded list of in-scope (Workspace-targeted) setting keys that the bulk
 * push migrates from VS Code config into the DB on first opt-in. Derived from
 * the `package.json` configuration schema, restricted to genuinely
 * Workspace-scoped settings.
 *
 * Intentionally EXCLUDED: the workflow toggles written by
 * `KanbanProvider._savePromptsConfig` (`accurateCoding.enabled`,
 * `reviewer.advancedMode`, `leadCoder.inlineChallenge`,
 * `aggressivePairProgramming.enabled`, `planner.designDocEnabled`,
 * `planner.designDocLink`, `planner.gitProhibitionEnabled`). Those ship as
 * Global (user) settings (`config.update(..., true)`), and per Scope
 * Clarification #2 Global settings are not DB-synced.
 *
 * Maintenance: when a new Workspace-scoped `switchboard.*` setting is added to
 * `package.json`, append its dotpath here.
 */
const SYNCABLE_KEYS: readonly string[] = [
    'excludeReviewedBacklogFromDropdown',
    'protocol.target',
    'workspace.ignoreStrategy',
    'workspace.ignoreRules',
    'statusBar.showTerminalControls',
    'statusBar.showKanbanButton',
    'statusBar.showArtifactsButton',
    'statusBar.showDesignButton',
    'statusBar.showProjectButton',
    'statusBar.showMemoButton',
    'statusBar.compactMode',
    'theme.disableCyberAnimation',
    'theme.disableCyberScanlines',
    'theme.colourKanbanIcons',
    'theme.name',
];

export class SettingsSyncService {
    private _isRestoring = false;
    private _workspaceRootResolver: () => string | null;

    constructor(workspaceRootResolver: () => string | null) {
        this._workspaceRootResolver = workspaceRootResolver;
    }

    /** Update the workspace-root resolver (e.g. after KanbanProvider is constructed). */
    public setWorkspaceRootResolver(resolver: () => string | null): void {
        this._workspaceRootResolver = resolver;
    }

    /** True if DB sync is enabled (reads `switchboard.settings.dbSyncEnabled`). */
    public isEnabled(): boolean {
        return vscode.workspace.getConfiguration('switchboard').get<boolean>(DBSYNC_TOGGLE_KEY, false);
    }

    /** True while the activation-time restore is replaying DB values into VS Code config. */
    public get isRestoring(): boolean {
        return this._isRestoring;
    }

    /**
     * Returns true only for Workspace-targeted `switchboard.*` keys that are in
     * the syncable set. The `dbSyncEnabled` toggle itself is excluded to avoid a
     * self-trigger loop (it is persisted separately as `setting.settings.dbSyncEnabled`).
     */
    public isInScope(key: string, target: vscode.ConfigurationTarget): boolean {
        if (target !== vscode.ConfigurationTarget.Workspace) return false;
        if (key === DBSYNC_TOGGLE_KEY) return false;
        return SYNCABLE_KEYS.includes(key);
    }

    /**
     * Wrap a `config.update()` call. Writes to VS Code config first; if sync is
     * enabled, the write target is Workspace, the key is in scope, and we are not
     * currently restoring from DB, also upsert into the active workspace `kanban.db`.
     *
     * The `dbSyncEnabled` toggle itself routes through here too — it is persisted
     * to the DB unconditionally when sync is being turned ON (so the toggle
     * survives across IDEs), and removed when turned OFF.
     */
    public async updateSetting(
        key: string,
        value: unknown,
        target: vscode.ConfigurationTarget
    ): Promise<void> {
        const config = vscode.workspace.getConfiguration('switchboard');
        await config.update(key, value, target);

        if (target !== vscode.ConfigurationTarget.Workspace) return;
        if (this._isRestoring) return;

        // The toggle itself: persist when enabling, drop when disabling.
        if (key === DBSYNC_TOGGLE_KEY) {
            if (value === true) {
                await this.syncToDb(key, value);
            } else {
                await this.removeFromDb(key);
            }
            return;
        }

        if (!this.isEnabled()) return;
        if (!this.isInScope(key, target)) return;
        await this.syncToDb(key, value);
    }

    /**
     * Sync a single key/value pair to the active workspace DB. JSON-encodes the
     * value. Per-DB write failures are caught and logged — the VS Code config
     * write must still succeed.
     */
    public async syncToDb(key: string, value: unknown): Promise<void> {
        const db = await this._getActiveDb();
        if (!db) return;
        try {
            const dbKey = SETTING_KEY_PREFIX + key;
            const ok = await db.setConfigStamped(dbKey, JSON.stringify(value));
            if (!ok) {
                console.warn(`[SettingsSync] setConfigStamped returned false for key "${dbKey}"`);
            }
        } catch (e) {
            console.warn(`[SettingsSync] DB write failed for setting "${key}":`, e);
        }
    }

    /**
     * Catch-all for the `onDidChangeConfiguration` listener. For each in-scope
     * `switchboard.*` key that the event reports as changed, read the current
     * value from VS Code config and upsert it into the DB. Skipped entirely when
     * sync is disabled or while `_isRestoring` (activation-time replay).
     *
     * This is the primary sync path — it catches changes made via the VS Code
     * Settings UI as well as in-process `config.update()` calls that did not
     * route through `updateSetting`.
     */
    public async syncChangedSettings(e: vscode.ConfigurationChangeEvent): Promise<void> {
        if (!this.isEnabled()) return;
        if (this._isRestoring) return;
        const config = vscode.workspace.getConfiguration('switchboard');
        for (const key of SYNCABLE_KEYS) {
            const fullKey = 'switchboard.' + key;
            if (!e.affectsConfiguration(fullKey)) continue;
            const inspect = config.inspect(key);
            const resolved = inspect?.workspaceValue ?? inspect?.defaultValue;
            if (resolved === undefined) continue;
            await this.syncToDb(key, resolved);
        }
    }

    /** Remove a setting row from the active workspace DB. */
    public async removeFromDb(key: string): Promise<void> {
        const db = await this._getActiveDb();
        if (!db) return;
        try {
            await db.deleteConfig(SETTING_KEY_PREFIX + key);
        } catch (e) {
            console.warn(`[SettingsSync] DB delete failed for setting "${key}":`, e);
        }
    }

    /**
     * On activation, replay all `setting.*` rows from the active workspace DB
     * into VS Code config (Workspace target). Sets `_isRestoring` so the
     * `onDidChangeConfiguration` listener skips re-syncing these back to the DB.
     */
    public async restoreFromDb(): Promise<void> {
        const db = await this._getActiveDb();
        if (!db) return;

        // Always attempt to restore the toggle itself first — it may be ON in the
        // DB but still OFF in this IDE's VS Code config (chicken-and-egg: the
        // gate below reads VS Code config). Without this, IDE B would never
        // learn that IDE A enabled sync.
        const toggleRow = await db.getConfig(SETTING_KEY_PREFIX + DBSYNC_TOGGLE_KEY);
        if (toggleRow !== null) {
            try {
                const toggleValue = JSON.parse(toggleRow) === true;
                const config = vscode.workspace.getConfiguration('switchboard');
                this._isRestoring = true;
                try {
                    await config.update(DBSYNC_TOGGLE_KEY, toggleValue, vscode.ConfigurationTarget.Workspace);
                } finally {
                    this._isRestoring = false;
                }
            } catch (e) {
                console.warn('[SettingsSync] restore of dbSyncEnabled toggle failed:', e);
            }
        }

        // Now that the toggle is hydrated, gate the rest on isEnabled().
        if (!this.isEnabled()) return;

        this._isRestoring = true;
        try {
            const rows = await db.getConfigByPrefix(SETTING_KEY_PREFIX);
            const config = vscode.workspace.getConfiguration('switchboard');
            for (const { key, value } of rows) {
                // Skip the toggle — already restored above.
                if (key === SETTING_KEY_PREFIX + DBSYNC_TOGGLE_KEY) continue;
                // Strip the `setting.` prefix to recover the dotpath.
                const dotpath = key.startsWith(SETTING_KEY_PREFIX)
                    ? key.slice(SETTING_KEY_PREFIX.length)
                    : key;
                let parsed: unknown;
                try {
                    parsed = JSON.parse(value);
                } catch {
                    parsed = value;
                }
                try {
                    await config.update(dotpath, parsed, vscode.ConfigurationTarget.Workspace);
                } catch (e) {
                    console.warn(`[SettingsSync] restore failed for setting "${dotpath}":`, e);
                }
            }
        } finally {
            this._isRestoring = false;
        }
    }

    /**
     * One-time bulk push of current in-scope VS Code settings into the DB.
     * Gated behind an explicit UI button (default OFF) — never auto-runs on
     * activation, to avoid surprise writes for existing users.
     */
    public async bulkPushCurrentSettings(): Promise<number> {
        const db = await this._getActiveDb();
        if (!db) return 0;
        const config = vscode.workspace.getConfiguration('switchboard');
        let pushed = 0;
        for (const key of SYNCABLE_KEYS) {
            const value = config.inspect(key);
            // Prefer workspace value, then default.
            const resolved = value?.workspaceValue ?? value?.defaultValue;
            if (resolved === undefined) continue;
            try {
                await db.setConfigStamped(SETTING_KEY_PREFIX + key, JSON.stringify(resolved));
                pushed++;
            } catch (e) {
                console.warn(`[SettingsSync] bulk push failed for "${key}":`, e);
            }
        }
        return pushed;
    }

    private async _getActiveDb(): Promise<KanbanDatabase | undefined> {
        const root = this._workspaceRootResolver();
        if (!root) return undefined;
        try {
            const db = KanbanDatabase.forWorkspace(root);
            const ready = await db.ensureReady();
            if (!ready) return undefined;
            return db;
        } catch (e) {
            console.warn('[SettingsSync] active DB unavailable:', e);
            return undefined;
        }
    }
}
