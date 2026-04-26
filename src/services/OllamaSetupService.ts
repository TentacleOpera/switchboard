import * as cp from 'child_process';
import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';

export type OllamaMode = 'cloud' | 'local';
export type OllamaAuthState = 'unknown' | 'signed-in' | 'signed-out';

export type OllamaModelSummary = {
    name: string;
    displayName: string;
    mode: OllamaMode;
    installed: boolean;
    requiresDownload: boolean;
    sizeBytes?: number;
    description?: string;
    recommendedForClaudeLaunch?: boolean;
};

export type OllamaPullProgress = {
    model: string;
    status: string;
    percent?: number;
    completedBytes?: number;
    totalBytes?: number;
    done: boolean;
    error?: string;
    startedAt: string;
    finishedAt?: string;
};

export type OllamaInternConfig = {
    enabled: boolean;
    mode: OllamaMode;
    model: string;
    baseUrl: string;
};

export type OllamaSetupState = {
    installed: boolean;
    version?: string;
    daemonReachable: boolean;
    authState: OllamaAuthState;
    cloudModels: OllamaModelSummary[];
    localModels: OllamaModelSummary[];
    activePull?: OllamaPullProgress;
    intern: OllamaInternConfig;
    error?: string;
};

type ExecFileLike = (
    file: string,
    args: readonly string[],
    options: cp.ExecFileOptions,
    callback: (error: cp.ExecFileException | null, stdout: string, stderr: string) => void
) => cp.ChildProcess;

type OllamaSetupServiceOptions = {
    execFile?: ExecFileLike;
    createTerminal?: (options: vscode.TerminalOptions) => vscode.Terminal;
    openExternal?: (uri: vscode.Uri) => Thenable<boolean>;
    localBaseUrl?: string;
    cloudBaseUrl?: string;
};

type OllamaTagModel = {
    name?: string;
    size?: number;
    details?: {
        family?: string;
        parameter_size?: string;
    };
};

type OllamaTagResponse = {
    models?: OllamaTagModel[];
};

type OllamaPullStreamEvent = {
    status?: string;
    total?: number;
    completed?: number;
    done?: boolean;
    error?: string;
};

type InstallState = {
    installed: boolean;
    version?: string;
};

type LocalModelState = {
    reachable: boolean;
    models: OllamaModelSummary[];
    error?: string;
};

const OLLAMA_SETUP_TERMINAL_NAME = 'Switchboard Ollama';
const SAFE_MODEL_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const DEFAULT_PULL_STATUS = 'Preparing download...';

export const OLLAMA_LOCAL_BASE_URL = 'http://localhost:11434/api';
export const OLLAMA_CLOUD_BASE_URL = 'https://ollama.com/api';
export const DEFAULT_OLLAMA_CLAUDE_MODEL = 'gemma4:31b-cloud';

const CURATED_CLOUD_MODELS: readonly OllamaModelSummary[] = [
    {
        name: DEFAULT_OLLAMA_CLAUDE_MODEL,
        displayName: 'Gemma 4 31B Cloud',
        mode: 'cloud',
        installed: false,
        requiresDownload: false,
        description: 'Recommended cloud model for Claude Code through Ollama.',
        recommendedForClaudeLaunch: true
    }
];

const CURATED_LOCAL_MODELS: readonly OllamaModelSummary[] = [
    {
        name: 'qwen2.5-coder:7b',
        displayName: 'Qwen 2.5 Coder 7B',
        mode: 'local',
        installed: false,
        requiresDownload: true,
        sizeBytes: 4_700_000_000,
        description: 'Balanced local coding model.',
        recommendedForClaudeLaunch: true
    },
    {
        name: 'gemma3:4b',
        displayName: 'Gemma 3 4B',
        mode: 'local',
        installed: false,
        requiresDownload: true,
        sizeBytes: 3_300_000_000,
        description: 'Lightweight local fallback.'
    },
    {
        name: 'codellama:7b',
        displayName: 'Code Llama 7B',
        mode: 'local',
        installed: false,
        requiresDownload: true,
        sizeBytes: 3_800_000_000,
        description: 'Classic local coding option.'
    }
];

export class OllamaSetupService {
    private static readonly _pullProgressCache = new Map<string, OllamaPullProgress>();
    private static readonly _activePulls = new Map<string, Promise<void>>();
    private static readonly _pullReservations = new Set<string>();
    private static readonly _authStateCache = new Map<string, OllamaAuthState>();

    constructor(
        private readonly _workspaceRoot: string,
        private readonly _options: OllamaSetupServiceOptions = {}
    ) { }

    public async getSetupState(intern: OllamaInternConfig): Promise<OllamaSetupState> {
        const installState = await this._checkInstall();
        if (!installState.installed) {
            return {
                installed: false,
                version: installState.version,
                daemonReachable: false,
                authState: OllamaSetupService._authStateCache.get(this._workspaceRoot) || 'unknown',
                cloudModels: this._getCloudModels(),
                localModels: this._getCuratedLocalModels(),
                activePull: this._getWorkspaceActivePull(),
                intern,
                error: 'Install the Ollama CLI to enable cloud sign-in, local model downloads, and Claude Code launch.'
            };
        }

        const localState = await this._loadLocalModels();
        return {
            installed: true,
            version: installState.version,
            daemonReachable: localState.reachable,
            authState: OllamaSetupService._authStateCache.get(this._workspaceRoot) || 'unknown',
            cloudModels: this._getCloudModels(),
            localModels: localState.models,
            activePull: this._getWorkspaceActivePull(),
            intern,
            error: localState.error
        };
    }

    public async openInstallPage(): Promise<void> {
        const openExternal = this._options.openExternal || vscode.env.openExternal;
        await openExternal(vscode.Uri.parse('https://ollama.com/download'));
    }

    public async signIn(): Promise<void> {
        await this._ensureInstalled();
        OllamaSetupService._authStateCache.set(this._workspaceRoot, 'unknown');
        const terminal = this._getSetupTerminal(true);
        terminal.sendText('ollama signin', true);
    }

    public async signOut(): Promise<void> {
        await this._ensureInstalled();
        await this._execFile('ollama', ['signout']);
        OllamaSetupService._authStateCache.set(this._workspaceRoot, 'signed-out');
    }

    public async pullModel(modelName: string): Promise<{ started: boolean; error?: string }> {
        const normalizedModel = this._normalizeModelName(modelName);
        const key = this._getCacheKey(normalizedModel);
        if (OllamaSetupService._activePulls.has(key) || OllamaSetupService._pullReservations.has(key)) {
            return { started: true };
        }
        OllamaSetupService._pullReservations.add(key);

        try {
            await this._ensureInstalled();
            const daemonReachable = await this._pingLocalApi();
            if (!daemonReachable) {
                return { started: false, error: 'Start the local Ollama daemon before pulling a model.' };
            }

            const initialProgress: OllamaPullProgress = {
                model: normalizedModel,
                status: DEFAULT_PULL_STATUS,
                percent: 0,
                done: false,
                startedAt: new Date().toISOString()
            };
            OllamaSetupService._pullProgressCache.set(key, initialProgress);

            const activePull = this._streamPull(normalizedModel)
                .finally(() => {
                    OllamaSetupService._activePulls.delete(key);
                });
            OllamaSetupService._activePulls.set(key, activePull);
            void activePull;

            return { started: true };
        } finally {
            OllamaSetupService._pullReservations.delete(key);
        }
    }

    public getPullProgress(modelName: string): OllamaPullProgress | undefined {
        const normalizedModel = this._normalizeModelName(modelName);
        const progress = OllamaSetupService._pullProgressCache.get(this._getCacheKey(normalizedModel));
        return progress ? { ...progress } : undefined;
    }

    public async launchClaudeCode(modelName: string): Promise<void> {
        const normalizedModel = this._normalizeModelName(modelName);
        const setupState = await this.getSetupState({
            enabled: false,
            mode: 'cloud',
            model: DEFAULT_OLLAMA_CLAUDE_MODEL,
            baseUrl: this._getCloudBaseUrl()
        });
        const knownCloudModel = setupState.cloudModels.some(model => model.name === normalizedModel);
        const knownLocalModel = setupState.localModels.find(model => model.name === normalizedModel);
        if (!knownCloudModel && !knownLocalModel) {
            throw new Error('Select a known Ollama model before launching Claude Code.');
        }
        if (knownLocalModel && !knownLocalModel.installed) {
            throw new Error(`Download ${normalizedModel} before launching Claude Code locally.`);
        }

        const terminal = this._getSetupTerminal(false);
        terminal.show(true);
        terminal.sendText(`ollama launch claude --model ${normalizedModel}`, true);
    }

    private async _ensureInstalled(): Promise<void> {
        const installState = await this._checkInstall();
        if (!installState.installed) {
            throw new Error('Install the Ollama CLI first.');
        }
    }

    private async _checkInstall(): Promise<InstallState> {
        try {
            const { stdout, stderr } = await this._execFile('ollama', ['--version']);
            const version = this._firstNonEmptyLine(stdout) || this._firstNonEmptyLine(stderr) || 'Installed';
            return { installed: true, version };
        } catch (error) {
            const message = this._getErrorMessage(error);
            if (message.includes('ENOENT') || message.includes('not found')) {
                return { installed: false };
            }
            throw new Error(`Failed to check Ollama CLI installation: ${message}`);
        }
    }

    private async _loadLocalModels(): Promise<LocalModelState> {
        try {
            const response = await this._requestJson<OllamaTagResponse>(this._createApiUrl(this._getLocalBaseUrl(), 'tags'));
            return {
                reachable: true,
                models: this._mergeLocalModels(Array.isArray(response.models) ? response.models : [])
            };
        } catch (error) {
            return {
                reachable: false,
                models: this._getCuratedLocalModels(),
                error: this._getErrorMessage(error)
            };
        }
    }

    private async _pingLocalApi(): Promise<boolean> {
        try {
            await this._requestJson<Record<string, unknown>>(this._createApiUrl(this._getLocalBaseUrl(), 'version'));
            return true;
        } catch {
            return false;
        }
    }

    private async _streamPull(modelName: string): Promise<void> {
        const key = this._getCacheKey(modelName);
        const url = this._createApiUrl(this._getLocalBaseUrl(), 'pull');
        const body = JSON.stringify({ model: modelName, stream: true });
        const requestFn = url.protocol === 'https:' ? https.request : http.request;

        await new Promise<void>((resolve, reject) => {
            let settled = false;
            let buffer = '';

            const finishWithError = (message: string): void => {
                if (settled) return;
                settled = true;
                this._setPullProgress(key, {
                    status: 'Failed',
                    error: message,
                    done: true,
                    finishedAt: new Date().toISOString()
                });
                reject(new Error(message));
            };

            const finishSuccess = (): void => {
                if (settled) return;
                settled = true;
                const current = OllamaSetupService._pullProgressCache.get(key);
                this._setPullProgress(key, {
                    status: current?.error ? 'Failed' : 'Ready',
                    done: true,
                    percent: current?.error ? current.percent : 100,
                    finishedAt: new Date().toISOString()
                });
                resolve();
            };

            const request = requestFn(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body).toString()
                }
            }, (response) => {
                // Node emits socket errors/aborts on `response`, not `request`,
                // once headers have arrived. Without these the streaming pull
                // Promise orphans forever on mid-stream socket failures.
                response.on('error', (err: Error) => {
                    finishWithError(this._getErrorMessage(err));
                });
                response.on('aborted', () => {
                    finishWithError('Ollama pull response aborted by server.');
                });

                if (!response.statusCode || response.statusCode >= 400) {
                    let errorBody = '';
                    response.setEncoding('utf8');
                    response.on('data', (chunk: string) => {
                        errorBody += chunk;
                    });
                    response.on('end', () => {
                        finishWithError(errorBody.trim() || `Ollama pull failed with status ${response.statusCode}.`);
                    });
                    return;
                }

                response.setEncoding('utf8');
                response.on('data', (chunk: string) => {
                    buffer += chunk;
                    let newlineIndex = buffer.indexOf('\n');
                    while (newlineIndex >= 0) {
                        const line = buffer.slice(0, newlineIndex).trim();
                        buffer = buffer.slice(newlineIndex + 1);
                        if (line) {
                            try {
                                this._handlePullStreamEvent(key, JSON.parse(line) as OllamaPullStreamEvent);
                            } catch (error) {
                                finishWithError(this._getErrorMessage(error));
                                request.destroy();
                                return;
                            }
                        }
                        newlineIndex = buffer.indexOf('\n');
                    }
                });
                response.on('end', () => {
                    const trailing = buffer.trim();
                    if (trailing) {
                        try {
                            this._handlePullStreamEvent(key, JSON.parse(trailing) as OllamaPullStreamEvent);
                        } catch (error) {
                            finishWithError(this._getErrorMessage(error));
                            return;
                        }
                    }
                    finishSuccess();
                });
            });

            request.on('error', (error: Error) => {
                finishWithError(this._getErrorMessage(error));
            });
            request.write(body);
            request.end();
        });
    }

    private _handlePullStreamEvent(key: string, event: OllamaPullStreamEvent): void {
        if (event.error) {
            this._setPullProgress(key, {
                status: 'Failed',
                error: event.error,
                done: true,
                finishedAt: new Date().toISOString()
            });
            return;
        }

        const current = OllamaSetupService._pullProgressCache.get(key);
        const totalBytes = typeof event.total === 'number' ? event.total : current?.totalBytes;
        const completedBytes = typeof event.completed === 'number' ? event.completed : current?.completedBytes;
        const percent = totalBytes && completedBytes !== undefined
            ? Math.min(100, Math.round((completedBytes / totalBytes) * 100))
            : current?.percent;

        this._setPullProgress(key, {
            status: event.status || current?.status || DEFAULT_PULL_STATUS,
            totalBytes,
            completedBytes,
            percent,
            done: event.done === true || current?.done === true
        });
    }

    private _setPullProgress(key: string, updates: Partial<OllamaPullProgress>): void {
        const current = OllamaSetupService._pullProgressCache.get(key);
        if (!current) {
            return;
        }
        OllamaSetupService._pullProgressCache.set(key, {
            ...current,
            ...updates
        });
    }

    private _getCloudModels(): OllamaModelSummary[] {
        const authState = OllamaSetupService._authStateCache.get(this._workspaceRoot) || 'unknown';
        return CURATED_CLOUD_MODELS.map(model => ({
            ...model,
            installed: authState === 'signed-in'
        }));
    }

    private _getCuratedLocalModels(): OllamaModelSummary[] {
        return CURATED_LOCAL_MODELS.map(model => ({ ...model }));
    }

    private _mergeLocalModels(installedModels: OllamaTagModel[]): OllamaModelSummary[] {
        const merged = new Map<string, OllamaModelSummary>();
        for (const model of this._getCuratedLocalModels()) {
            merged.set(model.name, model);
        }
        for (const model of installedModels) {
            const name = String(model?.name || '').trim();
            if (!name) continue;
            const existing = merged.get(name);
            merged.set(name, {
                name,
                displayName: existing?.displayName || name,
                mode: 'local',
                installed: true,
                requiresDownload: false,
                sizeBytes: typeof model.size === 'number' ? model.size : existing?.sizeBytes,
                description: this._describeInstalledModel(model, existing),
                recommendedForClaudeLaunch: existing?.recommendedForClaudeLaunch === true
            });
        }
        return Array.from(merged.values()).sort((left, right) => {
            if (left.installed !== right.installed) {
                return left.installed ? -1 : 1;
            }
            return left.displayName.localeCompare(right.displayName);
        });
    }

    private _describeInstalledModel(model: OllamaTagModel, existing?: OllamaModelSummary): string {
        const family = String(model?.details?.family || '').trim();
        const parameterSize = String(model?.details?.parameter_size || '').trim();
        if (family && parameterSize) {
            return `${family} · ${parameterSize} · installed locally`;
        }
        if (family) {
            return `${family} · installed locally`;
        }
        return existing?.description ? `${existing.description} · installed locally` : 'Installed locally';
    }

    private _getSetupTerminal(hidden?: boolean): vscode.Terminal {
        const existing = vscode.window.terminals.find(terminal => {
            const terminalOptions = terminal.creationOptions as vscode.TerminalOptions | undefined;
            return terminal.name === OLLAMA_SETUP_TERMINAL_NAME || terminalOptions?.name === OLLAMA_SETUP_TERMINAL_NAME;
        });
        if (existing) {
            return existing;
        }
        const createTerminal = this._options.createTerminal || vscode.window.createTerminal;
        return createTerminal({
            name: OLLAMA_SETUP_TERMINAL_NAME,
            cwd: this._workspaceRoot,
            hideFromUser: !!hidden
        });
    }

    private async _execFile(file: string, args: readonly string[], options: cp.ExecFileOptions = {}): Promise<{ stdout: string; stderr: string }> {
        const execFile = this._options.execFile || cp.execFile;
        return new Promise((resolve, reject) => {
            execFile(
                file,
                args,
                { cwd: this._workspaceRoot, ...options },
                (error, stdout, stderr) => {
                    const normalizedStdout = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
                    const normalizedStderr = typeof stderr === 'string' ? stderr : stderr.toString('utf8');
                    if (error) {
                        const enrichedError = error as cp.ExecFileException & { stdout?: string; stderr?: string; };
                        enrichedError.stdout = normalizedStdout;
                        enrichedError.stderr = normalizedStderr;
                        reject(enrichedError);
                        return;
                    }
                    resolve({ stdout: normalizedStdout, stderr: normalizedStderr });
                }
            );
        });
    }

    private async _requestJson<T>(url: URL): Promise<T> {
        const requestFn = url.protocol === 'https:' ? https.request : http.request;
        return new Promise<T>((resolve, reject) => {
            let settled = false;
            const safeResolve = (value: T) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            const safeReject = (err: Error) => {
                if (settled) return;
                settled = true;
                reject(err);
            };

            const request = requestFn(url, { method: 'GET' }, (response) => {
                let responseBody = '';
                // Response-stream errors/aborts must not orphan the Promise —
                // Node emits these on `response`, not `request`.
                response.on('error', (err: Error) => safeReject(err));
                response.on('aborted', () => safeReject(new Error('Ollama response aborted by server.')));
                response.setEncoding('utf8');
                response.on('data', (chunk: string) => {
                    responseBody += chunk;
                });
                response.on('end', () => {
                    if (!response.statusCode || response.statusCode >= 400) {
                        safeReject(new Error(responseBody.trim() || `Request failed with status ${response.statusCode}.`));
                        return;
                    }
                    try {
                        safeResolve((responseBody ? JSON.parse(responseBody) : {}) as T);
                    } catch (error) {
                        safeReject(error instanceof Error ? error : new Error(String(error)));
                    }
                });
            });
            request.on('error', (err: Error) => safeReject(err));
            request.end();
        });
    }

    private _getWorkspaceActivePull(): OllamaPullProgress | undefined {
        for (const [key, progress] of OllamaSetupService._pullProgressCache.entries()) {
            if (key.startsWith(`${this._workspaceRoot}::`) && progress.done !== true) {
                return { ...progress };
            }
        }
        return undefined;
    }

    private _getCacheKey(modelName: string): string {
        return `${this._workspaceRoot}::${modelName.toLowerCase()}`;
    }

    private _normalizeModelName(modelName: string): string {
        const normalized = String(modelName || '').trim();
        if (!SAFE_MODEL_NAME_RE.test(normalized)) {
            throw new Error('Invalid Ollama model name.');
        }
        return normalized;
    }

    private _createApiUrl(baseUrl: string, pathSegment: string): URL {
        const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
        return new URL(pathSegment, normalizedBase);
    }

    private _getLocalBaseUrl(): string {
        return (this._options.localBaseUrl || OLLAMA_LOCAL_BASE_URL).trim() || OLLAMA_LOCAL_BASE_URL;
    }

    private _getCloudBaseUrl(): string {
        return (this._options.cloudBaseUrl || OLLAMA_CLOUD_BASE_URL).trim() || OLLAMA_CLOUD_BASE_URL;
    }

    private _firstNonEmptyLine(value: string): string | undefined {
        return String(value || '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .find(Boolean);
    }

    private _getErrorMessage(error: unknown): string {
        if (error instanceof Error && error.message) {
            return error.message;
        }
        return String(error || 'Unknown error');
    }
}
