import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { request as httpRequest } from 'http';

export type PtyHostState = 'starting' | 'ready' | 'failed' | 'stopped';

export interface PtyHostResolution {
    value: string;
    source: 'explicit' | 'manifest';
    target: string;
}

export interface PtyHostReady {
    state: 'ready';
    port: number;
    terminalToken: string;
    protocolVersion: number;
}

export interface PtyHostSupervisorOptions {
    installRoot: string;
    workspaceRoot: string;
    artifactPath?: string;
    startupTimeoutMs?: number;
    surviveBoard?: boolean;
    onDiagnostic?: (message: string) => void;
}

interface ArtifactManifest {
    version: number;
    binary: string;
    targets: Record<string, string>;
}

export const PTY_IDE_NAME = 'switchboard-pty';
const PROTOCOL_VERSION = 1;

function targetKey(): string {
    const platform = process.platform === 'win32' ? 'win32' : process.platform;
    const arch = process.arch === 'x64' ? 'amd64' : process.arch;
    return `${platform}-${arch}`;
}

function readManifest(filePath: string): ArtifactManifest {
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`PTY host artifact manifest is missing or corrupt: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as ArtifactManifest).version !== 'number' || typeof (parsed as ArtifactManifest).binary !== 'string' || !(parsed as ArtifactManifest).targets) {
        throw new Error(`PTY host artifact manifest has invalid shape: ${filePath}`);
    }
    return parsed as ArtifactManifest;
}

export function resolvePtyHostExecutable(options: Pick<PtyHostSupervisorOptions, 'installRoot' | 'artifactPath'>): PtyHostResolution {
    const target = targetKey();
    const explicit = options.artifactPath;
    if (explicit) {
        const value = path.resolve(explicit);
        if (!fs.existsSync(value)) { throw new Error(`PTY host artifact missing: ${value} (source: explicit)`); }
        if (!fs.statSync(value).isFile()) { throw new Error(`PTY host artifact is not a file: ${value} (source: explicit)`); }
        return { value, source: 'explicit', target };
    }
    const manifestPath = path.join(options.installRoot, 'pty-host-artifacts.json');
    const manifest = readManifest(manifestPath);
    const relative = manifest.targets[target];
    if (!relative) { throw new Error(`PTY host unsupported on ${target}; manifest has no target mapping (source: manifest)`); }
    const installRoot = path.resolve(options.installRoot);
    const value = path.resolve(installRoot, relative);
    if (value !== installRoot && !value.startsWith(`${installRoot}${path.sep}`)) {
        throw new Error(`PTY host manifest escapes install root for ${target}: ${relative} (source: manifest)`);
    }
    if (!fs.existsSync(value)) { throw new Error(`PTY host artifact missing for ${target}: ${value} (source: manifest)`); }
    if (!fs.statSync(value).isFile()) { throw new Error(`PTY host artifact is not a file: ${value} (source: manifest)`); }
    if (process.platform !== 'win32' && (fs.statSync(value).mode & 0o111) === 0) { throw new Error(`PTY host artifact is not executable: ${value} (source: manifest)`); }
    return { value, source: 'manifest', target };
}

/**
 * Composition-time capability probe. Terminal availability is "is there a
 * platform-selected executable this host can actually spawn" — not "was a
 * supervisor object constructed". Both are true at activation; only the first
 * is a fact, and a hardcoded `true` (or a bare `!!supervisor` check) makes a
 * missing artifact indistinguishable from a working terminal runtime, which is
 * the fallback rule in CLAUDE.md.
 *
 * Pure filesystem work — no spawn, no handshake — so it is safe to call from a
 * composition root before anything is started. The `reason` is the resolver's
 * own message (missing target mapping, absent file, not executable), so the
 * host can log WHY terminals are unavailable rather than reporting a bare
 * false.
 */
export function probePtyHostAvailability(
    options: Pick<PtyHostSupervisorOptions, 'installRoot' | 'artifactPath'>
): { available: boolean; reason?: string; resolution?: PtyHostResolution } {
    try {
        return { available: true, resolution: resolvePtyHostExecutable(options) };
    } catch (error) {
        return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

export interface PtyHostIdentity {
    adopted: boolean;
    pid?: number;
    port?: number;
    startedAt?: number;
    uptime?: number;
    surviveBoard?: boolean;
    seatCount?: number;
}

export class PtyHostSupervisor {
    private child?: cp.ChildProcess;
    private state: PtyHostState = 'stopped';
    private ready?: PtyHostReady;
    private bootFailure?: Error;
    private stopPromise?: Promise<void>;
    private adopted: boolean = false;
    private hostPid?: number;
    private hostStartedAt?: number;

    public constructor(private readonly options: PtyHostSupervisorOptions) {}

    public getState(): PtyHostState { return this.state; }
    public getReady(): PtyHostReady | undefined { return this.ready; }
    public getFailure(): Error | undefined { return this.bootFailure; }
    public isAdopted(): boolean { return this.adopted; }
    public getHostPid(): number | undefined { return this.hostPid ?? this.child?.pid; }
    public getHostStartedAt(): number | undefined { return this.hostStartedAt; }
    public getSurviveBoard(): boolean { return !!this.options.surviveBoard; }

    public getIdentity(): PtyHostIdentity {
        const pid = this.getHostPid();
        const startedAt = this.hostStartedAt;
        const uptime = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : undefined;
        return {
            adopted: this.adopted,
            pid,
            port: this.ready?.port,
            startedAt,
            uptime,
            surviveBoard: !!this.options.surviveBoard,
        };
    }

    public setWorkspaceRoot(workspaceRoot: string): void {
        if (this.state === 'ready' || this.state === 'starting') throw new Error('PTY host workspace root is immutable after startup');
        this.options.workspaceRoot = workspaceRoot;
    }

    private getStateFilePath(): string {
        return path.join(this.options.workspaceRoot, '.switchboard', 'pty-host-state.json');
    }

    private async probeEndpoint(port: number, token: string, timeoutMs: number = 2000): Promise<any> {
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                request.destroy(new Error(`Probe timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            const request = httpRequest({
                hostname: '127.0.0.1',
                port,
                path: '/api/pty/ptyListTerminals',
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Content-Length': 2,
                },
            }, response => {
                clearTimeout(timer);
                if (response.statusCode !== 200) {
                    reject(new Error(`Probe returned status ${response.statusCode}`));
                    return;
                }
                const chunks: Buffer[] = [];
                response.on('data', chunk => chunks.push(Buffer.from(chunk)));
                response.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            request.on('error', err => {
                clearTimeout(timer);
                reject(err);
            });
            request.end('{}');
        });
    }

    private async tryAdopt(): Promise<PtyHostReady | null> {
        const stateFile = this.getStateFilePath();
        if (!fs.existsSync(stateFile)) {
            return null;
        }
        let data: any;
        try {
            data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        } catch {
            try { fs.unlinkSync(stateFile); } catch {}
            return null;
        }

        const { port, token, protocolVersion, workspaceRoot, pid, startedAt } = data || {};
        if (typeof port !== 'number' || typeof token !== 'string' || !token) {
            try { fs.unlinkSync(stateFile); } catch {}
            return null;
        }

        let probeResult: any;
        try {
            probeResult = await this.probeEndpoint(port, token, 2000);
        } catch {
            // No answer or timeout -> stale file, remove and spawn fresh
            try { fs.unlinkSync(stateFile); } catch {}
            return null;
        }

        // Check protocol version
        const probedVersion = probeResult?.protocolVersion ?? protocolVersion;
        if (probedVersion !== PROTOCOL_VERSION) {
            this.options.onDiagnostic?.(`[pty-host] Protocol version mismatch (probed: ${probedVersion}, expected: ${PROTOCOL_VERSION}). Stopping host and respawning.`);
            if (typeof pid === 'number' && pid > 0) {
                try { process.kill(pid, 'SIGTERM'); } catch {}
            }
            try { fs.unlinkSync(stateFile); } catch {}
            return null;
        }

        // Check workspaceRoot
        const expectedRoot = path.resolve(this.options.workspaceRoot);
        const probedRoot = probeResult?.workspaceRoot ? path.resolve(probeResult.workspaceRoot) : (workspaceRoot ? path.resolve(workspaceRoot) : '');
        if (probedRoot && probedRoot !== expectedRoot) {
            this.options.onDiagnostic?.(`[pty-host] Workspace root mismatch (probed: ${probedRoot}, expected: ${expectedRoot}). Refusing to adopt.`);
            throw new Error(`PTY host workspace root mismatch: host owns '${probedRoot}', expected '${expectedRoot}'`);
        }

        // Successfully verified and adopted
        this.adopted = true;
        this.hostPid = pid;
        this.hostStartedAt = startedAt;
        const ready: PtyHostReady = {
            state: 'ready',
            port,
            terminalToken: token,
            protocolVersion: PROTOCOL_VERSION,
        };
        this.ready = ready;
        this.state = 'ready';
        this.options.onDiagnostic?.(`[pty-host] Adopted existing PTY host (pid=${pid}, port=${port})`);
        return ready;
    }

    public async start(): Promise<PtyHostReady> {
        if (this.ready && ((this.child && this.child.exitCode === null) || this.adopted)) return this.ready;
        if (this.bootFailure) throw this.bootFailure;
        this.state = 'starting';

        // 1. Probe & adopt before spawn
        try {
            const adopted = await this.tryAdopt();
            if (adopted) {
                return adopted;
            }
        } catch (adoptError) {
            this.state = 'failed';
            this.bootFailure = adoptError instanceof Error ? adoptError : new Error(String(adoptError));
            throw this.bootFailure;
        }

        let resolution: PtyHostResolution;
        try {
            resolution = resolvePtyHostExecutable(this.options);
        } catch (error) {
            this.state = 'failed';
            this.bootFailure = error instanceof Error ? error : new Error(String(error));
            throw this.bootFailure;
        }
        this.options.onDiagnostic?.(`[pty-host] executable=${resolution.value} source=${resolution.source} target=${resolution.target}`);

        const survive = !!this.options.surviveBoard;
        const spawnArgs = ['--workspace', this.options.workspaceRoot];
        if (survive) {
            spawnArgs.push('--survive-parent');
        }

        const child = cp.spawn(resolution.value, spawnArgs, {
            stdio: survive ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
            cwd: this.options.workspaceRoot,
            detached: survive,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
        });
        if (survive) {
            child.unref();
        }
        this.child = child;
        this.adopted = false;
        this.hostPid = child.pid;
        this.hostStartedAt = Date.now();

        let buffer = '';
        const timeoutMs = this.options.startupTimeoutMs ?? 5000;
        try {
            const ready = await new Promise<PtyHostReady>((resolve, reject) => {
                let settled = false;
                const finish = (error?: Error, value?: PtyHostReady) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value!); };
                const timer = setTimeout(() => finish(new Error(`PTY host did not complete its handshake within ${timeoutMs}ms`)), timeoutMs);
                child.once('error', error => finish(new Error(`PTY host failed to start: ${error.message}`)));
                child.once('exit', (code, signal) => finish(new Error(`PTY host exited before handshake (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)));
                child.stdout?.on('data', (chunk: Buffer) => {
                    buffer += chunk.toString('utf8');
                    const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const message = JSON.parse(line) as { t?: string; port?: number; token?: string; version?: number };
                            const port = message.port;
                            const token = message.token;
                            if (message.t !== 'ready' || typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || typeof token !== 'string' || !token || message.version !== PROTOCOL_VERSION) {
                                finish(new Error('PTY host returned an invalid or unsupported ready handshake'));
                                return;
                            }
                            finish(undefined, { state: 'ready', port, terminalToken: token, protocolVersion: PROTOCOL_VERSION });
                            return;
                        } catch { /* wait for a complete JSON line */ }
                    }
                });
                child.stderr?.on('data', (chunk: Buffer) => this.options.onDiagnostic?.(`[pty-host stderr] ${chunk.toString('utf8').trim()}`));
            });
            this.ready = ready; this.state = 'ready'; return ready;
        } catch (error) {
            this.state = 'failed'; this.bootFailure = error instanceof Error ? error : new Error(String(error));
            try { child.kill('SIGTERM'); } catch { /* already exited */ }
            throw this.bootFailure;
        }
    }

    public async request(verb: string, payload: unknown, signal?: AbortSignal): Promise<any> {
        const ready = await this.start();
        return await new Promise((resolve, reject) => {
            const imagePayload = payload as { imageBuffer?: unknown; name?: string; mimeType?: string } | null;
            const imageBuffer = imagePayload?.imageBuffer;
            const isImage = verb === 'ptyPasteImage' && Buffer.isBuffer(imageBuffer);
            const body = isImage ? imageBuffer as Buffer : Buffer.from(JSON.stringify(payload ?? {}));
            const query = isImage ? `?name=${encodeURIComponent(imagePayload?.name || '')}&mimeType=${encodeURIComponent(imagePayload?.mimeType || 'image/png')}` : '';
            const request = httpRequest({ hostname: '127.0.0.1', port: ready.port, path: `/api/pty/${encodeURIComponent(verb)}${query}`, method: 'POST', headers: { Authorization: `Bearer ${ready.terminalToken}`, 'Content-Type': isImage ? 'application/octet-stream' : 'application/json', 'Content-Length': body.length } }, response => {
                const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); } });
            });
            request.on('error', reject); signal?.addEventListener('abort', () => request.destroy(new Error('PTY request aborted')), { once: true }); request.end(body);
        });
    }

    public async stopFleet(): Promise<{ stopped: boolean; pid?: number; message?: string }> {
        const stateFile = this.getStateFilePath();
        let pidToKill = this.getHostPid();
        if (!pidToKill && fs.existsSync(stateFile)) {
            try {
                const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
                if (typeof data.pid === 'number') pidToKill = data.pid;
            } catch {}
        }
        if (!pidToKill) {
            return { stopped: false, message: 'no fleet running' };
        }
        try {
            process.kill(pidToKill, 'SIGTERM');
        } catch (e: any) {
            if (e?.code !== 'ESRCH') {
                return { stopped: false, pid: pidToKill, message: e?.message || String(e) };
            }
        }
        try { fs.unlinkSync(stateFile); } catch {}
        this.child = undefined;
        this.ready = undefined;
        this.adopted = false;
        this.state = 'stopped';
        return { stopped: true, pid: pidToKill };
    }

    public async stop(): Promise<void> {
        if (this.stopPromise) return this.stopPromise;
        this.stopPromise = (async () => {
            const child = this.child;
            if (child) {
                try { child.stdin?.end(); } catch {}
                try { child.kill('SIGTERM'); } catch {}
                this.child = undefined;
            }
            this.ready = undefined;
            this.adopted = false;
            this.state = 'stopped';
        })();
        return this.stopPromise;
    }
}

export function defaultPtyHostInstallRoot(extensionRoot: string): string {
    return path.resolve(extensionRoot);
}

export function ptyHostTarget(): string { return targetKey(); }
