import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface GlobalConfig {
    migrationComplete?: boolean;
    clickup?: any;
    linear?: any;
    notion?: any;
    ticketsAutoSync?: boolean;
}

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

    public static async getTicketsAutoSync(): Promise<boolean> {
        const globalConfig = await this.loadGlobal();
        return globalConfig.ticketsAutoSync === true;
    }

    public static async setTicketsAutoSync(enabled: boolean): Promise<void> {
        const globalConfig = await this.loadGlobal();
        globalConfig.ticketsAutoSync = enabled;
        await this.saveGlobal(globalConfig);
    }
}
