import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { stateFile } from '../utils/stateHome';
import { parseCustomAgents } from './agentConfig';

export interface GlobalConfig {
    migrationComplete?: boolean;
    clickup?: any;
    linear?: any;
    notion?: any;
    ticketsAutoSync?: boolean;
    ticketsDownloadInlineImages?: boolean;
    /**
     * MCP Monitor settings that are global to the MACHINE — shared across every
     * workspace and IDE, because MCP servers are account-scoped.
     *
     * LEGACY: retained as a rollback safety net for one release after the
     * scheduler migration. The live source of truth is `scheduler` (below);
     * the comms job's `sourceConfig` mirrors this blob. Do not delete on
     * migration — the rollback path reads it if `scheduler` is absent.
     */
    mcpMonitor?: {
        enabled?: boolean;
        pollingEnabled?: boolean;
        targetRole?: string;
        sources?: string[];
        customInstruction?: string;
        sourceIntervals?: Record<string, number>;
        sourceLastCheckAt?: Record<string, string>;
        promptOverride?: string;
        slackChannels?: string;
        slackDmOnly?: boolean;
        slackChannelOnly?: boolean;
        gmailLabel?: string;
    };
    /**
     * Scheduler settings — the terminal-agnostic successor to `mcpMonitor`.
     * Holds an ordered list of `ScheduledJob`s. The comms monitor is one job
     * (`source: 'comms'`); board-batch / fetch-plans / reconcile / custom are
     * others. See
     * `SchedulerConfig` / `ScheduledJob` below for the shape.
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
        startupCommands?: Record<string, string>;
        visibleAgents?: Record<string, boolean>;
        customAgents?: any[];
    };
}

/** Agent-config keys that are stored machine-globally (cross-workspace, cross-IDE). */
export type AgentGlobalKey = 'startupCommands' | 'visibleAgents' | 'customAgents';

export interface McpMonitorConfig {
    enabled: boolean;                 // config-panel visibility only
    pollingEnabled: boolean;          // the loop gate
    targetRole: string;
    sources: string[];
    customInstruction: string;
    sourceIntervals: Record<string, number>;    // per-source minutes, e.g. { slack: 2, gmail: 30 }
    sourceLastCheckAt: Record<string, string>;   // per-source ISO UTC baseline
    promptOverride?: string;
    slackChannels?: string;
    slackDmOnly?: boolean;
    slackChannelOnly?: boolean;
    gmailLabel?: string;
}

export const DEFAULT_MCP_MONITOR_CONFIG: McpMonitorConfig = {
    enabled: false,
    pollingEnabled: false,
    targetRole: 'scheduler',
    sources: ['slack'],
    customInstruction: '',
    sourceIntervals: { slack: 5, gmail: 5, gcal: 5, custom: 5 },
    sourceLastCheckAt: {},
};

/**
 * A single scheduled job. `source` picks the prompt preset; `target` picks the
 * execution surface. `sourceConfig` is an untyped bag whose shape is owned by
 * the source (comms packs the legacy McpMonitorConfig fields; fetch-plans packs
 * remote/branchGlob; other sources pack their own). Downstream consumers cast based on `source`.
 */
export interface ScheduledJob {
    id: string;
    label: string;
    enabled: boolean;
    source: 'comms' | 'board-batch' | 'reconcile' | 'custom' | 'fetch-plans';
    target: 'local-terminal' | 'antigravity' | 'cloud';
    intervalMinutes: number;
    promptOverride?: string;
    startupCommand?: string;
    sourceConfig: Record<string, unknown>;
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

/** Stable id for the migrated comms job (deterministic across machines). */
export const COMMS_JOB_ID = 'comms-monitor';

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
        'notion.lastSync',
        'mcpMonitor.sourceLastCheckAt',
        'scheduler.jobs'
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
        if (copy.mcpMonitor) {
            delete copy.mcpMonitor.sourceLastCheckAt;
            if (Object.keys(copy.mcpMonitor).length === 0) {
                delete copy.mcpMonitor;
            }
        }
        if (copy.scheduler?.jobs && Array.isArray(copy.scheduler.jobs)) {
            for (const job of copy.scheduler.jobs) {
                if (job.sourceConfig?.sourceLastCheckAt) {
                    delete job.sourceConfig.sourceLastCheckAt;
                }
            }
        }
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

    private static DEFAULT_VISIBLE_AGENTS: Record<string, boolean> = {
        lead: true,
        coder: true,
        intern: true,
        reviewer: true,
        tester: false,
        planner: true,
        analyst: true,
        jules: false,
        ticket_updater: false,
        researcher: false,
        claude_designer: false,
        phone_a_friend: false,
        project_manager: true
    };

    // System-managed terminal roles that are launched by automation (Kanban
    // AUTOMATION tab / scheduler / Jules monitor, unattended batch improvers), NOT
    // user-selectable agent roles. They must never appear in the terminals.html role
    // picker. They can leak into the machine-global visibleAgents file via stale config
    // and are preserved by mergeVisibleAgentsToGlobalFile (which never removes un-patched
    // keys), so they must be stripped at the read layer. This strips the picker only —
    // it does not hide a running terminal; the `hidden` flag is what hides a terminal.
    private static SYSTEM_ONLY_ROLES = new Set(['orchestrator', 'mcp_monitor', 'jules_monitor', 'scheduler', 'improver_claude', 'improver_devin', 'improver_openai', 'improver_anthropic', 'improver_google']);

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

        const visible: Record<string, boolean> = { ...this.DEFAULT_VISIBLE_AGENTS };
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

    public static async getAgentStartupCommands(): Promise<Record<string, string> | undefined> {
        return this.getAgentConfig<Record<string, string>>('startupCommands');
    }

    public static async setAgentStartupCommands(commands: Record<string, string>): Promise<void> {
        await this.setAgentConfig('startupCommands', commands);
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

    // ─── Scheduler accessors (new, terminal-agnostic) ───────────────────────

    /**
     * Synthesize a comms `ScheduledJob` from a legacy `mcpMonitor` blob.
     * Packs every legacy field verbatim into `sourceConfig`; mirrors
     * `pollingEnabled` → `job.enabled` and `promptOverride` → `job.promptOverride`
     * so the engine's per-job dispatch sees them without unpacking.
     *
     * NOTE on interval: the comms job's real tick interval is the GCD of
     * `sourceIntervals`, computed in the engine (plan 2). `intervalMinutes`
     * here is a placeholder default; the engine ignores it for `source: 'comms'`
     * and uses the GCD. Non-comms jobs use `intervalMinutes` directly. This
     * split is intentional — do not mistake the placeholder for dead code.
     */
    private static _migrateCommsJob(mcpMonitor: NonNullable<GlobalConfig['mcpMonitor']>): ScheduledJob {
        const cfg: McpMonitorConfig = {
            enabled: mcpMonitor.enabled ?? DEFAULT_MCP_MONITOR_CONFIG.enabled,
            pollingEnabled: mcpMonitor.pollingEnabled ?? DEFAULT_MCP_MONITOR_CONFIG.pollingEnabled,
            targetRole: mcpMonitor.targetRole ?? DEFAULT_MCP_MONITOR_CONFIG.targetRole,
            sources: mcpMonitor.sources ?? DEFAULT_MCP_MONITOR_CONFIG.sources,
            customInstruction: mcpMonitor.customInstruction ?? DEFAULT_MCP_MONITOR_CONFIG.customInstruction,
            sourceIntervals: { ...DEFAULT_MCP_MONITOR_CONFIG.sourceIntervals, ...(mcpMonitor.sourceIntervals || {}) },
            sourceLastCheckAt: { ...(mcpMonitor.sourceLastCheckAt || {}) },
            promptOverride: mcpMonitor.promptOverride,
            slackChannels: mcpMonitor.slackChannels,
            slackDmOnly: mcpMonitor.slackDmOnly,
            slackChannelOnly: mcpMonitor.slackChannelOnly,
            gmailLabel: mcpMonitor.gmailLabel,
        };
        return {
            id: COMMS_JOB_ID,
            label: 'Comms Monitor',
            enabled: cfg.pollingEnabled,
            source: 'comms',
            target: 'local-terminal',
            intervalMinutes: 5,
            promptOverride: cfg.promptOverride,
            sourceConfig: {
                enabled: cfg.enabled,
                pollingEnabled: cfg.pollingEnabled,
                targetRole: cfg.targetRole,
                sources: cfg.sources,
                customInstruction: cfg.customInstruction,
                sourceIntervals: cfg.sourceIntervals,
                sourceLastCheckAt: cfg.sourceLastCheckAt,
                promptOverride: cfg.promptOverride,
                slackChannels: cfg.slackChannels,
                slackDmOnly: cfg.slackDmOnly,
                slackChannelOnly: cfg.slackChannelOnly,
                gmailLabel: cfg.gmailLabel,
            },
        };
    }

    /**
     * One-time migration: if `scheduler` is absent but `mcpMonitor` is present,
     * synthesize a comms job and write the new `SchedulerConfig`. Compare-and-
     * swap guarded — re-reads the file and only writes if `scheduler` is still
     * absent (a concurrent writer wins). Forward-compat: a `scheduler` whose
     * `schemaVersion` is newer than known is returned as-is, never re-migrated.
     *
     * Returns the resolved `SchedulerConfig` (migrated or existing). Does NOT
     * delete the legacy `mcpMonitor` blob (rollback safety net for one release).
     */
    private static _ensureSchedulerMigration(globalConfig: GlobalConfig): SchedulerConfig {
        const existing = globalConfig.scheduler;
        if (existing && typeof existing.schemaVersion === 'number') {
            if (existing.schemaVersion > SCHEDULER_SCHEMA_VERSION) {
                // Forward-compat: unknown newer schema — do not migrate, return as-is.
                console.warn(`[GlobalIntegrationConfigService] scheduler schemaVersion ${existing.schemaVersion} is newer than known ${SCHEDULER_SCHEMA_VERSION}; returning as-is without migration.`);
                return { schemaVersion: existing.schemaVersion, jobs: Array.isArray(existing.jobs) ? existing.jobs : [] };
            }
            return { schemaVersion: existing.schemaVersion, jobs: Array.isArray(existing.jobs) ? existing.jobs : [] };
        }
        // No scheduler yet — migrate from mcpMonitor if present (even if empty,
        // so the comms job shape is stable). If neither exists, return default.
        const legacy = globalConfig.mcpMonitor;
        const jobs: ScheduledJob[] = legacy ? [this._migrateCommsJob(legacy)] : [];
        return { schemaVersion: SCHEDULER_SCHEMA_VERSION, jobs };
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
            if (globalConfig.mcpMonitor || migrated.jobs.length > 0) {
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
            if (globalConfig.mcpMonitor || migrated.jobs.length > 0) {
                await this._persistMigratedSchedulerIfAbsent(migrated);
            }
            return migrated;
        }
        return this._ensureSchedulerMigration(globalConfig);
    }

    public static async setSchedulerConfig(config: Partial<SchedulerConfig>): Promise<void> {
        const globalConfig = await this.loadGlobal();
        const current = this._ensureSchedulerMigration(globalConfig);
        const nextSchema = config.schemaVersion ?? current.schemaVersion;
        const nextJobs = config.jobs ?? current.jobs;
        globalConfig.scheduler = { schemaVersion: nextSchema, jobs: nextJobs };
        await this.saveGlobal(globalConfig);
    }

    /** Find the comms job (`source === 'comms'`) in the scheduler config. */
    private static _findCommsJob(jobs: ScheduledJob[]): ScheduledJob | undefined {
        return jobs.find(j => j.source === 'comms');
    }

    /**
     * Unpack a comms job's `sourceConfig` into the legacy `McpMonitorConfig`
     * shape, applying the exact `?? DEFAULT_MCP_MONITOR_CONFIG` default-merge
     * the pre-migration accessors used. Shim fidelity: byte-for-byte consistent
     * with the migrated comms job.
     */
    private static _unpackCommsJob(job: ScheduledJob | undefined): McpMonitorConfig {
        if (!job) {
            return { ...DEFAULT_MCP_MONITOR_CONFIG, sourceLastCheckAt: {} };
        }
        const sc = (job.sourceConfig || {}) as Record<string, any>;
        return {
            enabled: sc.enabled ?? DEFAULT_MCP_MONITOR_CONFIG.enabled,
            pollingEnabled: sc.pollingEnabled ?? DEFAULT_MCP_MONITOR_CONFIG.pollingEnabled,
            targetRole: sc.targetRole ?? DEFAULT_MCP_MONITOR_CONFIG.targetRole,
            sources: sc.sources ?? DEFAULT_MCP_MONITOR_CONFIG.sources,
            customInstruction: sc.customInstruction ?? DEFAULT_MCP_MONITOR_CONFIG.customInstruction,
            sourceIntervals: { ...DEFAULT_MCP_MONITOR_CONFIG.sourceIntervals, ...(sc.sourceIntervals || {}) },
            sourceLastCheckAt: { ...(sc.sourceLastCheckAt || {}) },
            promptOverride: sc.promptOverride,
            slackChannels: sc.slackChannels,
            slackDmOnly: sc.slackDmOnly,
            slackChannelOnly: sc.slackChannelOnly,
            gmailLabel: sc.gmailLabel,
        };
    }

    // ─── Legacy comms shims (read/write the migrated comms job) ────────────
    //
    // These preserve the pre-migration accessor surface so plans 2–4 can cut
    // over incrementally. They read/write the comms job in `SchedulerConfig`;
    // the legacy `mcpMonitor` blob is only read as a fallback when no
    // scheduler config exists yet (pre-migration / rollback).

    public static getMcpMonitorConfigSync(): McpMonitorConfig {
        const globalConfig = this.loadGlobalSync();
        if (globalConfig.scheduler) {
            const resolved = this._ensureSchedulerMigration(globalConfig);
            return this._unpackCommsJob(this._findCommsJob(resolved.jobs));
        }
        // Pre-migration / rollback: read legacy blob directly.
        const cfg = globalConfig.mcpMonitor || {};
        return {
            enabled: cfg.enabled ?? DEFAULT_MCP_MONITOR_CONFIG.enabled,
            pollingEnabled: cfg.pollingEnabled ?? DEFAULT_MCP_MONITOR_CONFIG.pollingEnabled,
            targetRole: cfg.targetRole ?? DEFAULT_MCP_MONITOR_CONFIG.targetRole,
            sources: cfg.sources ?? DEFAULT_MCP_MONITOR_CONFIG.sources,
            customInstruction: cfg.customInstruction ?? DEFAULT_MCP_MONITOR_CONFIG.customInstruction,
            sourceIntervals: { ...DEFAULT_MCP_MONITOR_CONFIG.sourceIntervals, ...(cfg.sourceIntervals || {}) },
            sourceLastCheckAt: { ...(cfg.sourceLastCheckAt || {}) },
            promptOverride: cfg.promptOverride,
            slackChannels: cfg.slackChannels,
            slackDmOnly: cfg.slackDmOnly,
            slackChannelOnly: cfg.slackChannelOnly,
            gmailLabel: cfg.gmailLabel,
        };
    }

    public static async getMcpMonitorConfig(): Promise<McpMonitorConfig> {
        const globalConfig = await this.loadGlobal();
        if (globalConfig.scheduler) {
            const resolved = this._ensureSchedulerMigration(globalConfig);
            return this._unpackCommsJob(this._findCommsJob(resolved.jobs));
        }
        const cfg = globalConfig.mcpMonitor || {};
        return {
            enabled: cfg.enabled ?? DEFAULT_MCP_MONITOR_CONFIG.enabled,
            pollingEnabled: cfg.pollingEnabled ?? DEFAULT_MCP_MONITOR_CONFIG.pollingEnabled,
            targetRole: cfg.targetRole ?? DEFAULT_MCP_MONITOR_CONFIG.targetRole,
            sources: cfg.sources ?? DEFAULT_MCP_MONITOR_CONFIG.sources,
            customInstruction: cfg.customInstruction ?? DEFAULT_MCP_MONITOR_CONFIG.customInstruction,
            sourceIntervals: { ...DEFAULT_MCP_MONITOR_CONFIG.sourceIntervals, ...(cfg.sourceIntervals || {}) },
            sourceLastCheckAt: { ...(cfg.sourceLastCheckAt || {}) },
            promptOverride: cfg.promptOverride,
            slackChannels: cfg.slackChannels,
            slackDmOnly: cfg.slackDmOnly,
            slackChannelOnly: cfg.slackChannelOnly,
            gmailLabel: cfg.gmailLabel,
        };
    }

    public static async setMcpMonitorConfig(config: Partial<McpMonitorConfig>): Promise<void> {
        const globalConfig = await this.loadGlobal();
        const resolved = this._ensureSchedulerMigration(globalConfig);
        const jobs = [...resolved.jobs];
        const idx = jobs.findIndex(j => j.source === 'comms');
        if (idx < 0) {
            // Update-only: do not auto-create a comms job if none exists
            return;
        }
        const current = this._unpackCommsJob(jobs[idx]);
        const merged: McpMonitorConfig = {
            enabled: config.enabled ?? current.enabled,
            pollingEnabled: config.pollingEnabled ?? current.pollingEnabled,
            targetRole: config.targetRole ?? current.targetRole,
            sources: config.sources ?? current.sources,
            customInstruction: config.customInstruction ?? current.customInstruction,
            sourceIntervals: { ...DEFAULT_MCP_MONITOR_CONFIG.sourceIntervals, ...(current.sourceIntervals || {}), ...(config.sourceIntervals || {}) },
            sourceLastCheckAt: { ...(current.sourceLastCheckAt || {}), ...(config.sourceLastCheckAt || {}) },
            promptOverride: config.promptOverride ?? current.promptOverride,
            slackChannels: config.slackChannels ?? current.slackChannels,
            slackDmOnly: config.slackDmOnly ?? current.slackDmOnly,
            slackChannelOnly: config.slackChannelOnly ?? current.slackChannelOnly,
            gmailLabel: config.gmailLabel ?? current.gmailLabel,
        };
        const job: ScheduledJob = {
            ...jobs[idx],
            id: jobs[idx].id || COMMS_JOB_ID,
            label: jobs[idx].label || 'Comms Monitor',
            enabled: merged.pollingEnabled,
            source: 'comms',
            target: jobs[idx].target || 'local-terminal',
            intervalMinutes: jobs[idx].intervalMinutes || 5,
            promptOverride: merged.promptOverride,
            sourceConfig: {
                enabled: merged.enabled,
                pollingEnabled: merged.pollingEnabled,
                targetRole: merged.targetRole,
                sources: merged.sources,
                customInstruction: merged.customInstruction,
                sourceIntervals: merged.sourceIntervals,
                sourceLastCheckAt: merged.sourceLastCheckAt,
                promptOverride: merged.promptOverride,
                slackChannels: merged.slackChannels,
                slackDmOnly: merged.slackDmOnly,
                slackChannelOnly: merged.slackChannelOnly,
                gmailLabel: merged.gmailLabel,
            },
        };
        jobs[idx] = job;
        globalConfig.scheduler = { schemaVersion: resolved.schemaVersion, jobs };
        await this.saveGlobal(globalConfig);
    }
}
