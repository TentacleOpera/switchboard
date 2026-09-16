import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { stateFile } from '../utils/stateHome';
import { parseCustomAgents, DEFAULT_VISIBLE_AGENTS } from './agentConfig';

export interface GlobalConfig {
    migrationComplete?: boolean;
    clickup?: any;
    linear?: any;
    notion?: any;
    ticketsAutoSync?: boolean;
    ticketsDownloadInlineImages?: boolean;
    /**
     * Scheduler settings — holds an ordered list of `ScheduledJob`s.
     * See `SchedulerConfig` / `ScheduledJob` below for the shape.
     */
    scheduler?: {
        schemaVersion?: number;
        jobs?: ScheduledJob[];
    };
    /**
     * Agent settings that are global to the MACHINE — shared across every
     * workspace AND every IDE (VS Code, Cursor, Windsurf, …), because they
     * live in a single ~/.switchboard file rather than per-workspace DBs or
     * per-IDE globalState. Startup commands belong here: an "agent" (the CLI
     * you launch) is the same tool regardless of which repo or editor opened it.
     */
    agents?: {
        /**
         * Machines the operator has registered. `local` is always present and
         * undeletable. See {@link AgentMachine} and the plan
         * `agents-are-saved-per-machine-and-a-team-picks-one`.
         */
        machines?: AgentMachine[];
        startupCommands?: Record<string, string>;
        /**
         * Per-machine startup commands: `machineStartupCommands[machineId][role]`.
         * The legacy flat `startupCommands` is the migration source for the
         * `local` machine and is kept as a read-fallback for one release so a
         * caller not yet threaded with the machine id still resolves.
         */
        machineStartupCommands?: Record<string, Record<string, string>>;
        visibleAgents?: Record<string, boolean>;
        customAgents?: any[];
        /**
         * Agent-control model config, NORMALISED.
         *
         *   agentControlProviders  — the rows: one record per provider id, each
         *                            owning its own endpoint/model.
         *   agentControlProvider   — a pointer at the active row.
         *
         * The active endpoint/model are DERIVED by looking the pointer up. They
         * are deliberately not also stored flat: the same fact in two places is
         * two facts that can disagree, with no rule for which wins.
         *
         * A model name is only meaningful to the provider it was chosen for
         * ('gemma-4-31b-it' on Google vs 'google/gemma-4-31b-it:free' on
         * OpenRouter), which is why the model belongs to the row and not to the
         * surface. Switching the pointer recalls that provider's own values.
         *
         * The API key is NOT here — it is per-row in the encrypted secrets store
         * under `switchboard.agentControl.apiKey.<providerId>`.
         *
         * `agentControlEndpoint`/`agentControlModel` are the pre-normalisation
         * flat keys. They are READ ONCE to migrate an existing config into its
         * row and are never written again; they are not a fallback, because a
         * stale flat value winning over a row is the divergence this shape
         * exists to prevent.
         */
        agentControlEndpoint?: string;
        agentControlModel?: string;
        agentControlProvider?: string;
        agentControlProviders?: Record<string, { endpoint?: string; model?: string }>;
    };
}

/**
 * A machine the operator can run agent seats on. A team picks ONE machine;
 * every seat in that team (head + delegates) spawns on it. The
 * `transportPrefix` is the `user@host` (or host alias) the spawn layer wraps
 * the inner CLI with; `transport` picks the wrapping shape (`ssh`
 * single-quote-wraps, `mosh` uses `--`).
 *
 * `local` is `{ id: 'local', name: 'Local', transport: 'local', transportPrefix: '' }`
 * — always present, undeletable. A `local` seat's rendered command equals its
 * inner CLI unchanged.
 */
export interface AgentMachine {
    id: string;
    name: string;
    transport: 'local' | 'ssh' | 'mosh';
    /** `user@host` (or host alias). Empty for `local`. */
    transportPrefix: string;
}

/** The always-present default machine. */
export const LOCAL_AGENT_MACHINE: AgentMachine = {
    id: 'local',
    name: 'Local',
    transport: 'local',
    transportPrefix: '',
};

/** Agent-config keys that are stored machine-globally (cross-workspace, cross-IDE). */
export type AgentGlobalKey = 'startupCommands' | 'visibleAgents' | 'customAgents'
    | 'agentControlEndpoint' | 'agentControlModel' | 'agentControlProvider'
    | 'agentControlProviders';

/**
 * A single scheduled job. `source` picks the prompt preset; `target` picks the
 * execution surface. `sourceConfig` is an untyped bag whose shape is owned by
 * the source (fetch-plans packs remote/branchGlob; other sources pack their
 * own). Downstream consumers cast based on `source`.
 */
export interface ScheduledJob {
    id: string;
    label: string;
    enabled: boolean;
    source:
        | 'reconcile'
        | 'custom'
        | 'fetch-plans'
        | 'team-automation'
        | 'advance-plan'
        | 'phone-a-friend'
        | 'advance-feature'
        | 'batch-advance-planning'
        | 'review-code-vs-intent'
        | 'process-memo'
        | 'improve-docs'
        | 'update-readme'
        | 'send-plans-to-jules'
        | 'start-ready-mission'
        | 'research'
        | 'git-pull-push';
    target: 'local-terminal' | 'antigravity' | 'cloud';
    intervalMinutes: number;
    promptOverride?: string;
    startupCommand?: string;
    sourceConfig: Record<string, unknown>;
    teamTarget?: { groupId: string; role?: string };
    advanceWhenReady?: boolean;
    lastRunAt?: number;
    lastOutcome?: string;
    lastTarget?: string;
}

/**
 * Container for all scheduler jobs. `schemaVersion` anchors future migrations —
 * without it the next migration has no branch point. Bump only when the
 * persisted shape changes in a way old code cannot read.
 */
export interface SchedulerConfig {
    schemaVersion: number;
    jobs: ScheduledJob[];
}

export const SCHEDULER_SCHEMA_VERSION = 1;

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
    schemaVersion: SCHEDULER_SCHEMA_VERSION,
    jobs: [],
};

export class GlobalIntegrationConfigService {
    private static getFilePath(): string {
        return stateFile('integration-config.json');
    }

    private static getCacheDir(): string {
        return stateFile('cache');
    }

    public static getGlobalCachePath(filename: string): string {
        const cacheDir = this.getCacheDir();
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        return path.join(cacheDir, filename);
    }

    public static async loadGlobal(): Promise<GlobalConfig> {
        const filePath = this.getFilePath();
        if (!fs.existsSync(filePath)) {
            return {};
        }
        try {
            const content = await fs.promises.readFile(filePath, 'utf8');
            return JSON.parse(content) as GlobalConfig;
        } catch (err) {
            console.error('[GlobalIntegrationConfigService] Failed to load global config:', err);
            return {};
        }
    }

    public static loadGlobalSync(): GlobalConfig {
        const filePath = this.getFilePath();
        if (!fs.existsSync(filePath)) {
            return {};
        }
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(content) as GlobalConfig;
        } catch (err) {
            console.error('[GlobalIntegrationConfigService] Failed to load global config sync:', err);
            return {};
        }
    }

    public static loadConfigSync(provider: 'clickup' | 'linear' | 'notion'): any {
        const globalConfig = this.loadGlobalSync();
        return globalConfig[provider] || null;
    }

    public static readonly CHURN_PATHS = [
        'clickup.lastSync',
        'linear.lastSync',
        'notion.lastSync'
    ];

    private static _canonicalStringify(obj: any): string {
        if (obj === null || typeof obj !== 'object') {
            return JSON.stringify(obj);
        }
        if (Array.isArray(obj)) {
            return '[' + obj.map((item) => this._canonicalStringify(item)).join(',') + ']';
        }
        const keys = Object.keys(obj).sort();
        return '{' + keys.map((k) => JSON.stringify(k) + ':' + this._canonicalStringify(obj[k])).join(',') + '}';
    }

    private static _stripChurnFields(config: GlobalConfig): GlobalConfig {
        const copy = structuredClone(config);
        if (copy.clickup && 'lastSync' in copy.clickup) delete copy.clickup.lastSync;
        if (copy.linear && 'lastSync' in copy.linear) delete copy.linear.lastSync;
        if (copy.notion && 'lastSync' in copy.notion) delete copy.notion.lastSync;
        return copy;
    }

    public static isSignificantWrite(existingConfig: GlobalConfig, incomingConfig: GlobalConfig): boolean {
        const strippedExisting = this._stripChurnFields(existingConfig);
        const strippedIncoming = this._stripChurnFields(incomingConfig);
        return this._canonicalStringify(strippedExisting) !== this._canonicalStringify(strippedIncoming);
    }

    private static _snapshotBeforeWrite(reason: string, incomingConfig: GlobalConfig): void {
        try {
            const filePath = this.getFilePath();
            if (!fs.existsSync(filePath)) {
                return;
            }

            let existingContent = '';
            try {
                existingContent = fs.readFileSync(filePath, 'utf8');
            } catch {
                return;
            }

            let existingConfig: GlobalConfig | null = null;
            try {
                existingConfig = JSON.parse(existingContent);
            } catch {
                // Unparseable existing file -> always snapshot
            }

            if (existingConfig !== null && !this.isSignificantWrite(existingConfig, incomingConfig)) {
                return;
            }

            const backupDir = stateFile('configbackup');
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
            }

            const now = new Date();
            const tsStr = now.toISOString().replace(/[:.]/g, '-');
            const sanitizedReason = reason.replace(/[^a-zA-Z0-9_-]/g, '_');
            const hex = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
            const filename = `integration-config.${tsStr}.${sanitizedReason}.${hex}.json`;
            const backupPath = path.join(backupDir, filename);

            fs.copyFileSync(filePath, backupPath);
            fs.chmodSync(backupPath, 0o600);

            this._pruneSnapshots(backupDir);
        } catch (err) {
            console.error('[GlobalIntegrationConfigService] Failed to snapshot config:', err);
        }
    }

    private static _pruneSnapshots(backupDir: string): void {
        try {
            const files = fs.readdirSync(backupDir);
            const snapshotFiles = files
                .filter((f) => /^integration-config\..+\.json$/.test(f))
                .map((f) => ({
                    filename: f,
                    fullPath: path.join(backupDir, f)
                }))
                .sort((a, b) => a.filename.localeCompare(b.filename));

            if (snapshotFiles.length > 10) {
                const toRemove = snapshotFiles.slice(0, snapshotFiles.length - 10);
                for (const item of toRemove) {
                    try {
                        fs.unlinkSync(item.fullPath);
                    } catch {}
                }
            }
        } catch (err) {
            console.error('[GlobalIntegrationConfigService] Failed to prune snapshots:', err);
        }
    }

    public static async saveGlobal(config: GlobalConfig): Promise<void> {
        this._snapshotBeforeWrite('save', config);
        const filePath = this.getFilePath();
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const tempPath = `${filePath}.tmp`;
        const content = JSON.stringify(config, null, 2);

        try {
            await fs.promises.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
            await fs.promises.rename(tempPath, filePath);
        } catch (err) {
            console.error('[GlobalIntegrationConfigService] Failed to save global config:', err);
            if (fs.existsSync(tempPath)) {
                try {
                    await fs.promises.unlink(tempPath);
                } catch {}
            }
            throw err;
        }
    }

    public static async loadConfig(provider: 'clickup' | 'linear' | 'notion'): Promise<any> {
        const globalConfig = await this.loadGlobal();
        return globalConfig[provider] || null;
    }

    public static providerConfigMeaningfulCount(provider: 'clickup' | 'linear' | 'notion', blob: any): number {
        if (!blob || typeof blob !== 'object') return 0;
        let count = 0;
        if (provider === 'clickup') {
            if (blob.workspaceId && String(blob.workspaceId).trim() !== '') count++;
            if (blob.selectedSpaceId && String(blob.selectedSpaceId).trim() !== '') count++;
            if (blob.selectedFolderId && String(blob.selectedFolderId).trim() !== '') count++;
            if (blob.selectedListId && String(blob.selectedListId).trim() !== '') count++;
            if (blob.columnMappings && typeof blob.columnMappings === 'object' && Object.keys(blob.columnMappings).length > 0) count++;
            if (blob.customFields && typeof blob.customFields === 'object' && Object.keys(blob.customFields).length > 0) count++;
        } else if (provider === 'linear') {
            if (blob.teamId && String(blob.teamId).trim() !== '') count++;
            if (blob.switchboardLabelId && String(blob.switchboardLabelId).trim() !== '') count++;
            if (blob.columnToStateId && typeof blob.columnToStateId === 'object' && Object.keys(blob.columnToStateId).length > 0) count++;
            if (Array.isArray(blob.includeProjectNames) && blob.includeProjectNames.length > 0) count++;
        } else if (provider === 'notion') {
            if (blob.workspaceId && String(blob.workspaceId).trim() !== '') count++;
            if (blob.databaseId && String(blob.databaseId).trim() !== '') count++;
        }
        return count;
    }

    private static getProviderId(provider: 'clickup' | 'linear' | 'notion', blob: any): string | null {
        if (!blob || typeof blob !== 'object') return null;
        if (provider === 'clickup') return blob.workspaceId ? String(blob.workspaceId).trim() : null;
        if (provider === 'linear') return blob.teamId ? String(blob.teamId).trim() : null;
        if (provider === 'notion') return blob.workspaceId ? String(blob.workspaceId).trim() : null;
        return null;
    }

    private static checkFormatWarning(provider: 'clickup' | 'linear' | 'notion', id: string | null): void {
        if (!id) return;
        if (provider === 'clickup' && !/^\d+$/.test(id)) {
            console.warn(`[GlobalIntegrationConfigService] Warning: ClickUp workspaceId '${id}' is non-numeric.`);
        } else if (provider === 'linear' && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
            console.warn(`[GlobalIntegrationConfigService] Warning: Linear teamId '${id}' is not UUID-shaped.`);
        }
    }

    public static async saveConfig(
        provider: 'clickup' | 'linear' | 'notion',
        config: any,
        options?: { replace?: boolean }
    ): Promise<{ saved: boolean; reason?: string }> {
        const globalConfig = await this.loadGlobal();
        const stored = globalConfig[provider] || null;

        let mergedConfig: any;
        if (options?.replace || !stored) {
            mergedConfig = { ...config };
        } else {
            // Shallow merge: absent keys in config retain stored value
            mergedConfig = { ...stored };
            for (const key of Object.keys(config)) {
                mergedConfig[key] = config[key];
            }
        }

        // Wipe guard
        const incomingCount = this.providerConfigMeaningfulCount(provider, mergedConfig);
        const existingCount = this.providerConfigMeaningfulCount(provider, stored);
        if (incomingCount === 0 && existingCount > 0) {
            const msg = `Refusing to overwrite non-empty ${provider} config with an empty value (wipe guard).`;
            console.warn(`[GlobalIntegrationConfigService] ${msg}`);
            return { saved: false, reason: msg };
        }

        // Identity continuity guard
        const storedId = this.getProviderId(provider, stored);
        const incomingId = this.getProviderId(provider, mergedConfig);
        if (storedId && incomingId && storedId !== incomingId && !options?.replace) {
            const idKey = provider === 'clickup' ? 'workspaceId' : (provider === 'linear' ? 'teamId' : 'workspaceId');
            const msg = `Refusing identity change for ${provider} (${idKey}: stored '${storedId}' → incoming '${incomingId}'). Pass replace: true to override.`;
            console.warn(`[GlobalIntegrationConfigService] ${msg}`);
            return { saved: false, reason: msg };
        }

        // Format warning (warning only)
        this.checkFormatWarning(provider, incomingId);

        globalConfig[provider] = mergedConfig;
        await this.saveGlobal(globalConfig);
        return { saved: true };
    }

    public static async clearConfig(provider: 'clickup' | 'linear' | 'notion'): Promise<void> {
        const globalConfig = await this.loadGlobal();
        delete globalConfig[provider];
        await this.saveGlobal(globalConfig);
    }

    // System-managed terminal roles that are launched by automation (Kanban
    // AUTOMATION tab / scheduler / Jules monitor, unattended batch improvers), NOT
    // user-selectable agent roles. They must never appear in the terminals.html role
    // picker. They can leak into the machine-global visibleAgents file via stale config
    // and are preserved by mergeVisibleAgentsToGlobalFile (which never removes un-patched
    // keys), so they must be stripped at the read layer. This strips the picker only —
    // it does not hide a running terminal; the `hidden` flag is what hides a terminal.
    private static SYSTEM_ONLY_ROLES = new Set(['mission-control', 'mcp_monitor', 'jules_monitor', 'scheduler', 'improver_claude', 'improver_devin', 'improver_openai', 'improver_anthropic', 'improver_google']);

    /**
     * Read the machine-global visible-agents store and merge it over the built-in
     * defaults. Custom agents default to visible. Also returns a `hasCommand` map
     * so the UI can annotate roles with no configured startup command.
     */
    public static async getPtyVisibleRoles(): Promise<{ visibleAgents: Record<string, boolean>; hasCommand: Record<string, boolean> }> {
        const fileValue = (await this.getAgentConfig<Record<string, boolean>>('visibleAgents')) || {};
        const customRaw = await this.getAgentConfig<unknown[]>('customAgents');
        const custom = Array.isArray(customRaw) ? customRaw.filter(a => a && typeof (a as any).role === 'string') : [];
        const commands = (await this.getAgentStartupCommands()) || {};

        const visible: Record<string, boolean> = { ...DEFAULT_VISIBLE_AGENTS };
        for (const agent of parseCustomAgents(custom)) {
            visible[agent.role] = true;
        }
        Object.assign(visible, fileValue);

        // Strip system-managed terminal roles that leaked into the file. They are
        // launched by automation, not selectable by users, and must not appear in
        // the role picker or the OPEN AGENT TERMINALS path.
        for (const sysRole of this.SYSTEM_ONLY_ROLES) {
            delete visible[sysRole];
        }

        const hasCommand: Record<string, boolean> = {};
        for (const role of Object.keys(visible)) {
            const cmd = commands[role];
            hasCommand[role] = typeof cmd === 'string' && cmd.trim() !== '';
        }
        return { visibleAgents: visible, hasCommand };
    }

    /**
     * Machine-global startup commands (role → command), shared across all
     * workspaces and IDEs. Returns `undefined` when never written, so callers
     * can fall back to legacy per-IDE/per-workspace stores during migration.
     */
    public static getAgentConfigSync<T = any>(key: AgentGlobalKey): T | undefined {
        return this.loadGlobalSync().agents?.[key] as T | undefined;
    }

    public static async getAgentConfig<T = any>(key: AgentGlobalKey): Promise<T | undefined> {
        return (await this.loadGlobal()).agents?.[key] as T | undefined;
    }

    /**
     * Count of "meaningful" entries in an agent-config value. Used by the wipe
     * guard: startupCommands counts non-blank commands, visibleAgents counts
     * keys present (an all-false map is still an intentional config), customAgents
     * counts array items.
     */
    private static agentConfigMeaningfulCount(key: AgentGlobalKey, value: unknown): number {
        if (value === undefined || value === null) return 0;
        if (key === 'customAgents') return Array.isArray(value) ? value.length : 0;
        if (typeof value !== 'object') return 0;
        if (key === 'visibleAgents') return Object.keys(value as object).length;
        // startupCommands: a role with a blank command is not "set".
        return Object.values(value as Record<string, unknown>)
            .filter((v) => typeof v === 'string' && v.trim() !== '').length;
    }

    public static async setAgentConfig(key: AgentGlobalKey, value: unknown): Promise<void> {
        const globalConfig = await this.loadGlobal();

        // WIPE GUARD: never let an empty/all-blank startupCommands or visibleAgents
        // overwrite a populated stored value. This is what stops a reinstall (which
        // resets per-IDE globalState and can re-trigger onboarding/launch saves built
        // from an empty webview state) from blanking the user's real config. These two
        // keys are never legitimately emptied wholesale; customAgents CAN go to []
        // (deleting the last custom agent), so it is intentionally not guarded.
        if (key === 'startupCommands' || key === 'visibleAgents') {
            const incoming = this.agentConfigMeaningfulCount(key, value);
            const existing = this.agentConfigMeaningfulCount(key, globalConfig.agents?.[key]);
            if (incoming === 0 && existing > 0) {
                console.warn(`[GlobalIntegrationConfigService] Refusing to overwrite non-empty ${key} with an empty value (wipe guard).`);
                return;
            }
        }

        globalConfig.agents = { ...(globalConfig.agents || {}), [key]: value };
        await this.saveGlobal(globalConfig);
    }

    // Convenience wrappers (startup commands are the most-read agent config).
    public static getAgentStartupCommandsSync(): Record<string, string> | undefined {
        return this.getAgentConfigSync<Record<string, string>>('startupCommands');
    }

    /**
     * Resolve the startup-command map for a machine. When `machineId` is given,
     * returns `machineStartupCommands[machineId]`; when that is absent, falls
     * back to the legacy flat `startupCommands` (transition window — the legacy
     * key is the migration source for the `local` machine and is kept for one
     * release so a caller not yet threaded with the machine id still resolves).
     * When `machineId` is omitted, returns the legacy flat map (callers that
     * have not been threaded yet).
     */
    public static async getAgentStartupCommands(machineId?: string): Promise<Record<string, string> | undefined> {
        if (machineId) {
            await this._ensureMachineMigration();
            const globalConfig = await this.loadGlobal();
            const perMachine = globalConfig.agents?.machineStartupCommands?.[machineId];
            if (perMachine) { return perMachine; }
            // Transition fallback: the local machine's set may still live only
            // in the legacy flat key. Other machines have no legacy fallback —
            // an unknown machine id resolves to nothing, which is correct.
            if (machineId === 'local') {
                return globalConfig.agents?.startupCommands;
            }
            return undefined;
        }
        return this.getAgentConfig<Record<string, string>>('startupCommands');
    }

    public static async setAgentStartupCommands(commands: Record<string, string>): Promise<void> {
        await this.setAgentConfig('startupCommands', commands);
    }

    // ─── Machines ─────────────────────────────────────────────────────────

    /**
     * One-time migration: if `machineStartupCommands` is absent and the legacy
     * flat `startupCommands` is present, copy `startupCommands` into
     * `machineStartupCommands.local` and ensure `machines` contains `local`.
     * The legacy key is NOT deleted here — it stays as a read-fallback for one
     * release. Idempotent: a no-op when the new shape is already populated.
     */
    private static _machineMigrationDone = false;
    private static async _ensureMachineMigration(): Promise<void> {
        if (this._machineMigrationDone) { return; }
        this._machineMigrationDone = true;
        try {
            const globalConfig = await this.loadGlobal();
            const agents = globalConfig.agents || {};
            const hasMachineShape = !!agents.machineStartupCommands;
            const legacy = agents.startupCommands;
            if (hasMachineShape) {
                // Ensure `local` machine exists even when the shape is present
                // (an operator who hand-edited the file could drop it).
                const machines = Array.isArray(agents.machines) ? agents.machines : [];
                if (!machines.some(m => m && m.id === 'local')) {
                    globalConfig.agents = {
                        ...agents,
                        machines: [LOCAL_AGENT_MACHINE, ...machines],
                    };
                    await this.saveGlobal(globalConfig);
                }
                return;
            }
            // No machine shape yet — build it from the legacy flat map.
            const localCommands = (legacy && typeof legacy === 'object') ? legacy : {};
            const machines = Array.isArray(agents.machines) ? agents.machines : [];
            const withLocal = machines.some(m => m && m.id === 'local')
                ? machines
                : [LOCAL_AGENT_MACHINE, ...machines];
            globalConfig.agents = {
                ...agents,
                machines: withLocal,
                machineStartupCommands: { local: { ...localCommands } },
            };
            await this.saveGlobal(globalConfig);
        } catch (err) {
            console.error('[GlobalIntegrationConfigService] Machine migration failed:', err);
        }
    }

    /**
     * Return the machines list, always including `local`. Runs the migration
     * first so a fresh upgrade populates the shape before any read.
     */
    public static async getMachines(): Promise<AgentMachine[]> {
        await this._ensureMachineMigration();
        const globalConfig = await this.loadGlobal();
        const machines = Array.isArray(globalConfig.agents?.machines) ? globalConfig.agents!.machines! : [];
        if (!machines.some(m => m && m.id === 'local')) {
            return [LOCAL_AGENT_MACHINE, ...machines];
        }
        return machines;
    }

    public static async getMachineSync(machineId: string): Promise<AgentMachine | undefined> {
        const globalConfig = this.loadGlobalSync();
        const machines = Array.isArray(globalConfig.agents?.machines) ? globalConfig.agents!.machines! : [];
        return machines.find(m => m && m.id === machineId) ?? (machineId === 'local' ? LOCAL_AGENT_MACHINE : undefined);
    }

    /**
     * Persist the machines list. `local` is forced to the front and is never
     * removable — a caller that omits it gets it re-added. The team-pin check
     * (refusing to delete a machine a team still pins) lives at the
     * `deleteMachine` verb, which is the only caller that can read the team
     * store; this method does not perform it.
     */
    public static async setMachines(machines: AgentMachine[]): Promise<void> {
        const filtered = Array.isArray(machines) ? machines.filter(m => m && typeof m.id === 'string') : [];
        const hasLocal = filtered.some(m => m.id === 'local');
        const finalMachines = hasLocal ? filtered : [LOCAL_AGENT_MACHINE, ...filtered];
        const globalConfig = await this.loadGlobal();
        globalConfig.agents = { ...(globalConfig.agents || {}), machines: finalMachines };
        await this.saveGlobal(globalConfig);
    }

    public static async getMachineStartupCommands(machineId: string): Promise<Record<string, string> | undefined> {
        await this._ensureMachineMigration();
        const globalConfig = await this.loadGlobal();
        return globalConfig.agents?.machineStartupCommands?.[machineId];
    }

    /**
     * Persist a machine's startup-command map. When `machineId === 'local'`,
     * also mirrors the write to the legacy flat `startupCommands` key so the
     * transition-window read-fallback stays in sync. The wipe guard on the
     * legacy key is bypassed via a direct `saveGlobal` (an empty local set is a
     * legitimate operator action now, not a reinstall blanking).
     */
    public static async setMachineStartupCommands(machineId: string, commands: Record<string, string>): Promise<void> {
        await this._ensureMachineMigration();
        const globalConfig = await this.loadGlobal();
        const agents = globalConfig.agents || {};
        const perMachine = { ...(agents.machineStartupCommands || {}) };

        // WIPE GUARD — the same one `setAgentConfig` applies to the legacy flat
        // key, applied here too. This path is reached by the ordinary Agents-tab
        // save (`saveStartupCommands`), whose command map is built from the
        // webview's DOM inputs: a panel that posts before those inputs are
        // populated sends `{}`. Writing that straight through would blank the
        // machine's real command map AND, for `local`, the legacy key the guard
        // was added to protect — the exact reinstall-blanking the guard exists
        // to stop. An all-blank incoming map over a populated stored one is
        // refused loudly; emptying a set deliberately is done by deleting the
        // machine.
        const incoming = this.agentConfigMeaningfulCount('startupCommands', commands);
        const existingPerMachine = this.agentConfigMeaningfulCount('startupCommands', perMachine[machineId]);
        const existingLegacy = machineId === 'local'
            ? this.agentConfigMeaningfulCount('startupCommands', agents.startupCommands)
            : 0;
        if (incoming === 0 && (existingPerMachine > 0 || existingLegacy > 0)) {
            console.warn(`[GlobalIntegrationConfigService] Refusing to overwrite non-empty startup commands for machine '${machineId}' with an empty value (wipe guard).`);
            return;
        }

        perMachine[machineId] = commands;
        const nextAgents: any = { ...agents, machineStartupCommands: perMachine };
        if (machineId === 'local') {
            // Mirror to legacy flat key (transition fallback). Written directly
            // rather than through `setAgentConfig` so the two keys land in ONE
            // save — the wipe guard above already covers the case that guard
            // protects against.
            nextAgents.startupCommands = commands;
        }
        globalConfig.agents = nextAgents;
        await this.saveGlobal(globalConfig);
    }

    /**
     * Render the spawn command for a machine's transport. The inner CLI is the
     * per-machine `machineStartupCommands[machineId][role]` value; the rendered
     * command is what the spawn layer types into the pty.
     *
     * - `local` (empty prefix): the inner CLI unchanged.
     * - `ssh`: `ssh <prefix> '<cli>'` — the CLI is single-quote-wrapped as one
     *   remote argument. Inner single quotes are escaped (`'\''`).
     * - `mosh`: `mosh <prefix> -- <cli>` — `--` separates mosh args from the
     *   remote command.
     *
     * Returns the inner CLI unchanged when the machine is `local` or unknown
     * (a missing machine id is a runtime failure the operator handles, not a
     * config gate — falling back to the inner CLI keeps the seat runnable).
     */
    public static renderSpawnCommand(innerCli: string, machine: AgentMachine | undefined): string {
        if (!innerCli) { return innerCli; }
        if (!machine || machine.transport === 'local' || !machine.transportPrefix) {
            return innerCli;
        }
        const prefix = machine.transportPrefix;
        if (machine.transport === 'ssh') {
            const escaped = innerCli.replace(/'/g, "'\\''");
            return `ssh ${prefix} '${escaped}'`;
        }
        if (machine.transport === 'mosh') {
            return `mosh ${prefix} -- ${innerCli}`;
        }
        // Unknown transport — do not concat blindly (a dumb `<prefix> <cli>`
        // breaks one of the two known transports). Fall back to the inner CLI.
        return innerCli;
    }

    public static async getTicketsAutoSync(): Promise<boolean> {
        const globalConfig = await this.loadGlobal();
        return globalConfig.ticketsAutoSync === true;
    }

    public static async setTicketsAutoSync(enabled: boolean): Promise<void> {
        const globalConfig = await this.loadGlobal();
        globalConfig.ticketsAutoSync = enabled;
        await this.saveGlobal(globalConfig);
    }

    // ─── Scheduler accessors ────────────────────────────────────────────────

    /** Sources that have been deleted. Jobs with these sources are dropped on read.
     * Do NOT add 'team-automation' — see scheduled-automation-targeted-at-a-team-lead.md. */
    private static readonly DROPPED_SOURCES = new Set(['comms', 'board-batch']);

    /** Drop jobs whose source has been deleted (comms, board-batch) on read. */
    private static _filterDroppedSources(jobs: ScheduledJob[]): ScheduledJob[] {
        return jobs.filter(j => !this.DROPPED_SOURCES.has(j.source as string));
    }

    /**
     * Resolve the persisted `SchedulerConfig`, dropping jobs whose source has
     * been deleted (comms, board-batch) on READ — never via a
     * destructive write. The dropped jobs stay inert in the file until the
     * next legitimate `setSchedulerConfig` write, which preserves them in storage
     * while filtering from execution. Forward-compat: a `scheduler`
     * whose `schemaVersion` is newer than known is returned as-is (still
     * filtered).
     */
    private static _ensureSchedulerMigration(globalConfig: GlobalConfig): SchedulerConfig {
        const existing = globalConfig.scheduler;
        if (existing && typeof existing.schemaVersion === 'number') {
            if (existing.schemaVersion > SCHEDULER_SCHEMA_VERSION) {
                // Forward-compat: unknown newer schema — do not migrate, return as-is.
                console.warn(`[GlobalIntegrationConfigService] scheduler schemaVersion ${existing.schemaVersion} is newer than known ${SCHEDULER_SCHEMA_VERSION}; returning as-is without migration.`);
            }
            return { schemaVersion: existing.schemaVersion, jobs: this._filterDroppedSources(Array.isArray(existing.jobs) ? existing.jobs : []) };
        }
        // No scheduler yet — return default. The legacy mcpMonitor blob is
        // left inert in the file (loadGlobal/saveGlobal round-trip unknown keys).
        return { schemaVersion: SCHEDULER_SCHEMA_VERSION, jobs: [] };
    }

    /**
     * Persist the migrated `SchedulerConfig` only if `scheduler` is still
     * absent on a fresh re-read (compare-and-swap). Guards against a concurrent
     * writer clobbering a newer `scheduler` with a re-migrated one.
     */
    private static async _persistMigratedSchedulerIfAbsent(migrated: SchedulerConfig): Promise<void> {
        const fresh = await this.loadGlobal();
        if (fresh.scheduler) {
            // A concurrent writer already landed a scheduler — do not overwrite.
            console.warn('[GlobalIntegrationConfigService] scheduler appeared during migration; skipping write-back.');
            return;
        }
        fresh.scheduler = migrated;
        await this.saveGlobal(fresh);
    }

    /** Sync variant of the compare-and-swap write-back. */
    private static _persistMigratedSchedulerIfAbsentSync(migrated: SchedulerConfig): void {
        const fresh = this.loadGlobalSync();
        if (fresh.scheduler) {
            console.warn('[GlobalIntegrationConfigService] scheduler appeared during migration; skipping write-back.');
            return;
        }
        fresh.scheduler = migrated;
        try {
            this._snapshotBeforeWrite('scheduler-migration', fresh);
            const filePath = this.getFilePath();
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const tempPath = `${filePath}.tmp`;
            fs.writeFileSync(tempPath, JSON.stringify(fresh, null, 2), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(tempPath, filePath);
        } catch (err) {
            console.error('[GlobalIntegrationConfigService] Failed to persist migrated scheduler (sync):', err);
        }
    }

    public static getSchedulerConfigSync(): SchedulerConfig {
        const globalConfig = this.loadGlobalSync();
        if (!globalConfig.scheduler) {
            const migrated = this._ensureSchedulerMigration(globalConfig);
            if (migrated.jobs.length > 0) {
                this._persistMigratedSchedulerIfAbsentSync(migrated);
            }
            return migrated;
        }
        return this._ensureSchedulerMigration(globalConfig);
    }

    public static async getSchedulerConfig(): Promise<SchedulerConfig> {
        const globalConfig = await this.loadGlobal();
        if (!globalConfig.scheduler) {
            const migrated = this._ensureSchedulerMigration(globalConfig);
            if (migrated.jobs.length > 0) {
                await this._persistMigratedSchedulerIfAbsent(migrated);
            }
            return migrated;
        }
        return this._ensureSchedulerMigration(globalConfig);
    }

    public static async setSchedulerConfig(config: Partial<SchedulerConfig>): Promise<void> {
        const globalConfig = await this.loadGlobal();
        const rawJobs = Array.isArray(globalConfig.scheduler?.jobs) ? globalConfig.scheduler!.jobs! : [];
        // Preserve execution-filtered sources in STORAGE (comms, board-batch).
        // They are filtered from execution by _filterDroppedSources on read, but
        // must survive a write so the next read-after-write doesn't destroy them.
        const preserved = rawJobs.filter(j => this.DROPPED_SOURCES.has(j.source as string));
        const nextSchema = config.schemaVersion ?? (globalConfig.scheduler?.schemaVersion ?? SCHEDULER_SCHEMA_VERSION);
        const nextJobs = config.jobs ?? this._filterDroppedSources(rawJobs);
        // Merge: incoming jobs (no dropped sources) + preserved dropped-source jobs.
        const incomingIds = new Set(nextJobs.map(j => j.id));
        const merged = [...nextJobs, ...preserved.filter(j => !incomingIds.has(j.id))];
        globalConfig.scheduler = { schemaVersion: nextSchema, jobs: merged };
        await this.saveGlobal(globalConfig);
    }

    /**
     * One-time migration read: if a board-batch job exists in the raw persisted
     * config, return its intervalMinutes so the caller can migrate it into the
     * run-sheet schedule. Reads the raw file directly (bypassing
     * _filterDroppedSources) so the interval is visible even after prior reads
     * have filtered the job from the resolved SchedulerConfig. The caller is
     * responsible for latching (e.g. via a workspaceState flag) so the
     * migration write only happens once.
     */
    public static getMigratedBoardBatchInterval(): number | undefined {
        const globalConfig = this.loadGlobalSync();
        const scheduler = globalConfig.scheduler;
        if (!scheduler || !Array.isArray(scheduler.jobs)) return undefined;
        const boardBatchJob = scheduler.jobs.find(j => (j as any).source === 'board-batch');
        return boardBatchJob && typeof boardBatchJob.intervalMinutes === 'number'
            ? boardBatchJob.intervalMinutes
            : undefined;
    }

    /**
     * One-time migration read: return the labels of any `custom` jobs in the
     * raw persisted config (bypassing the DROPPED_SOURCES filter) so a
     * one-time notice can name what stopped. The caller is responsible for
     * latching via a workspaceState flag so this only fires once.
     */
    public static getDroppedCustomJobLabels(): string[] {
        const globalConfig = this.loadGlobalSync();
        const scheduler = globalConfig.scheduler;
        if (!scheduler || !Array.isArray(scheduler.jobs)) return [];
        return scheduler.jobs
            .filter(j => (j as any).source === 'custom')
            .map(j => (j as any).label || (j as any).id)
            .filter((l: string) => !!l);
    }
}
