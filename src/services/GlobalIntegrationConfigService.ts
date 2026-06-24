import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface GlobalConfig {
    migrationComplete?: boolean;
    clickup?: any;
    linear?: any;
    notion?: any;
    ticketsAutoSync?: boolean;
    /**
     * MCP Monitor settings that are global to the MACHINE — shared across every
     * workspace and IDE, because MCP servers are account-scoped.
     */
    mcpMonitor?: {
        enabled?: boolean;
        intervalMinutes?: number;
        targetRole?: string;
        sources?: string[];
        customInstruction?: string;
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
    enabled: boolean;
    intervalMinutes: number;
    targetRole: string;
    sources: string[];
    customInstruction: string;
}

export const DEFAULT_MCP_MONITOR_CONFIG: McpMonitorConfig = {
    enabled: false,
    intervalMinutes: 5,
    targetRole: 'mcp_monitor',
    sources: ['slack'],
    customInstruction: '',
};

export class GlobalIntegrationConfigService {
    private static getFilePath(): string {
        return path.join(os.homedir(), '.switchboard', 'integration-config.json');
    }

    private static getCacheDir(): string {
        return path.join(os.homedir(), '.switchboard', 'cache');
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

    public static async saveGlobal(config: GlobalConfig): Promise<void> {
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

    public static async saveConfig(provider: 'clickup' | 'linear' | 'notion', config: any): Promise<void> {
        const globalConfig = await this.loadGlobal();
        globalConfig[provider] = config;
        await this.saveGlobal(globalConfig);
    }

    public static async clearConfig(provider: 'clickup' | 'linear' | 'notion'): Promise<void> {
        const globalConfig = await this.loadGlobal();
        delete globalConfig[provider];
        await this.saveGlobal(globalConfig);
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

    public static getMcpMonitorConfigSync(): McpMonitorConfig {
        const globalConfig = this.loadGlobalSync();
        const cfg = globalConfig.mcpMonitor || {};
        return {
            enabled: cfg.enabled ?? DEFAULT_MCP_MONITOR_CONFIG.enabled,
            intervalMinutes: Math.max(cfg.intervalMinutes ?? DEFAULT_MCP_MONITOR_CONFIG.intervalMinutes, 1),
            targetRole: cfg.targetRole ?? DEFAULT_MCP_MONITOR_CONFIG.targetRole,
            sources: cfg.sources ?? DEFAULT_MCP_MONITOR_CONFIG.sources,
            customInstruction: cfg.customInstruction ?? DEFAULT_MCP_MONITOR_CONFIG.customInstruction,
        };
    }

    public static async getMcpMonitorConfig(): Promise<McpMonitorConfig> {
        const globalConfig = await this.loadGlobal();
        const cfg = globalConfig.mcpMonitor || {};
        return {
            enabled: cfg.enabled ?? DEFAULT_MCP_MONITOR_CONFIG.enabled,
            intervalMinutes: Math.max(cfg.intervalMinutes ?? DEFAULT_MCP_MONITOR_CONFIG.intervalMinutes, 1),
            targetRole: cfg.targetRole ?? DEFAULT_MCP_MONITOR_CONFIG.targetRole,
            sources: cfg.sources ?? DEFAULT_MCP_MONITOR_CONFIG.sources,
            customInstruction: cfg.customInstruction ?? DEFAULT_MCP_MONITOR_CONFIG.customInstruction,
        };
    }

    public static async setMcpMonitorConfig(config: Partial<McpMonitorConfig>): Promise<void> {
        const globalConfig = await this.loadGlobal();
        const current = globalConfig.mcpMonitor || {};
        globalConfig.mcpMonitor = {
            enabled: config.enabled ?? current.enabled ?? DEFAULT_MCP_MONITOR_CONFIG.enabled,
            intervalMinutes: Math.max(config.intervalMinutes ?? current.intervalMinutes ?? DEFAULT_MCP_MONITOR_CONFIG.intervalMinutes, 1),
            targetRole: config.targetRole ?? current.targetRole ?? DEFAULT_MCP_MONITOR_CONFIG.targetRole,
            sources: config.sources ?? current.sources ?? DEFAULT_MCP_MONITOR_CONFIG.sources,
            customInstruction: config.customInstruction ?? current.customInstruction ?? DEFAULT_MCP_MONITOR_CONFIG.customInstruction,
        };
        await this.saveGlobal(globalConfig);
    }
}
