/**
 * Host Settings — the one schema and service used by API, UI, CLI, and both
 * composition roots (plan: settings-window-and-the-write-path-review-deleted).
 *
 * The values that live in CLI flags and environment files get a surface an
 * operator can open: the workspace set, port, serve mode, and the PATH
 * additions agent CLIs need. Each shows where it resolved from, each can be
 * changed, and a change reaches the thing that reads it.
 *
 * Storage: `~/.switchboard/host-settings.json` (or the explicit
 * `SWITCHBOARD_STATE_HOME`), available before any workspace database is
 * selected. Atomic same-directory replace, file mode 0600, parent mode 0700.
 * In-process write serialization so concurrent requests cannot interleave
 * validation and replacement. A stable `revision` (sha256-16 of the stored
 * bytes) is returned with every read; `update` requires `expectedRevision` and
 * rejects a stale save with `StaleRevisionError` carrying the fresh state.
 *
 * Resolution is per field, in precedence order:
 *   1. an explicit per-field CLI flag or explicit `local`/`tailnet` subcommand;
 *   2. the durable host-settings document;
 *   3. a legacy `SWITCHBOARD_*` value when running the package's service entrypoint;
 *   4. a safe default whose source is literally `default`.
 * A fallback is NEVER collapsed into the same source label as a real value.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stateFile } from '../utils/stateHome';
import { expandAndResolve } from './WorkspaceIdentityService';

const HOST_SETTINGS_FILENAME = 'host-settings.json';
const SCHEMA_VERSION = 1;
const VALID_SERVE_MODES = new Set<ServeMode>(['local', 'tailnet']);
const MIN_PORT = 1;
const MAX_PORT = 65535;
const PATH_DELIM = process.platform === 'win32' ? ';' : ':';
/** Revision sentinel for a missing file — a real sha256-16 hex is never empty. */
export const EMPTY_REVISION = '';

export type ServeMode = 'local' | 'tailnet';
export type SourceLabel =
    | 'cli-flag'
    | 'cli-subcommand'
    | 'durable'
    | 'legacy-env'
    | 'default'
    | 'vscode-config';

export interface HostWorkspaceEntry {
    id: string;
    name: string;
    /** Canonical absolute root (after `~` expansion and path.resolve). */
    root: string;
}

export interface HostSettingsDocument {
    version: number;
    workspaces: HostWorkspaceEntry[];
    defaultWorkspaceId: string | null;
    port: number | null;
    serveMode: ServeMode | null;
    extraPath: string[];
    /** Unknown keys are preserved so a newer install is not downgraded by an older writer. */
    [key: string]: unknown;
}

export interface FieldResolution<T> {
    effectiveValue: T;
    effectiveSource: SourceLabel;
    configuredValue: T | null;
    configuredSource: SourceLabel | null;
    available: boolean;
    restartRequired: boolean;
}

export interface HostSettingsResolution {
    revision: string;
    workspaces: {
        value: HostWorkspaceEntry[];
        source: SourceLabel;
        configuredValue: HostWorkspaceEntry[] | null;
        configuredSource: SourceLabel | null;
    };
    defaultWorkspace: FieldResolution<HostWorkspaceEntry | null>;
    port: FieldResolution<number>;
    serveMode: FieldResolution<ServeMode>;
    extraPath: FieldResolution<string[]>;
}

export interface ExplicitInput {
    serveMode?: { value: ServeMode; source: 'cli-flag' | 'cli-subcommand' };
    port?: { value: number; source: 'cli-flag' };
    workspaceRoot?: { value: string; source: 'cli-flag' };
    extraPath?: { value: string[]; source: 'cli-flag' };
}

export interface LegacyEnvInput {
    serveMode?: string;
    port?: string;
    workspace?: string;
    extraPath?: string;
}

export interface VsCodeConfigInput {
    /** `switchboard.remote.tailnet` — explicit VS Code setting, stronger than durable. */
    tailnetEnabled?: boolean;
}

export interface HostSettingsContext {
    explicit?: ExplicitInput;
    legacy?: LegacyEnvInput;
    vscode?: VsCodeConfigInput;
}

export type HostSettingsErrorCode = 'corrupt' | 'invalid' | 'conflict' | 'io';

export class HostSettingsError extends Error {
    public readonly code: HostSettingsErrorCode;
    constructor(message: string, code: HostSettingsErrorCode) {
        super(message);
        this.name = 'HostSettingsError';
        this.code = code;
    }
}

export class StaleRevisionError extends HostSettingsError {
    public readonly freshState: HostSettingsResolution;
    constructor(fresh: HostSettingsResolution) {
        super('Stale revision — another writer updated host settings first', 'conflict');
        this.name = 'StaleRevisionError';
        this.freshState = fresh;
    }
}

export interface HostSettingsService {
    /** Read the durable document and resolve with default fallbacks (no CLI/legacy context). */
    read(): HostSettingsResolution;
    /** Read and resolve with an explicit/legacy/vscode context for source-tagged precedence. */
    resolve(ctx: HostSettingsContext): HostSettingsResolution;
    /** Validate, atomically write, and return the fresh resolution. Rejects with StaleRevisionError on conflict. */
    update(patch: Partial<HostSettingsDocument>, expectedRevision: string, ctx?: HostSettingsContext): Promise<HostSettingsResolution>;
    /** The absolute path to the host-settings.json file. */
    filePath(): string;
    /** True when a durable file exists on disk. */
    exists(): boolean;
}

function settingsFilePath(): string {
    return stateFile(HOST_SETTINGS_FILENAME);
}

function computeRevision(bytes: Buffer): string {
    return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function defaultDocument(): HostSettingsDocument {
    return {
        version: SCHEMA_VERSION,
        workspaces: [],
        defaultWorkspaceId: null,
        port: null,
        serveMode: null,
        extraPath: [],
    };
}

function validateWorkspaceEntry(entry: any, seenRoots: Set<string>, seenIds: Set<string>): HostWorkspaceEntry {
    if (!entry || typeof entry !== 'object') {
        throw new HostSettingsError('workspace entry must be an object', 'invalid');
    }
    const id = String(entry.id ?? '').trim();
    const name = String(entry.name ?? '').trim();
    const rootRaw = String(entry.root ?? '').trim();
    if (!id) throw new HostSettingsError('workspace entry missing id', 'invalid');
    if (!name) throw new HostSettingsError(`workspace '${id}' missing name`, 'invalid');
    if (!rootRaw) throw new HostSettingsError(`workspace '${id}' missing root`, 'invalid');
    if (/[\0\n\r]/.test(id) || /[\0\n\r]/.test(name)) {
        throw new HostSettingsError(`workspace '${id}' id/name contains NUL/newline`, 'invalid');
    }
    const root = path.resolve(expandAndResolve(rootRaw));
    if (!path.isAbsolute(root)) {
        throw new HostSettingsError(`workspace '${id}' root must be absolute after expansion`, 'invalid');
    }
    if (seenRoots.has(root)) {
        throw new HostSettingsError(`workspace '${id}' duplicate canonical root ${root}`, 'invalid');
    }
    if (seenIds.has(id)) {
        throw new HostSettingsError(`duplicate workspace id '${id}'`, 'invalid');
    }
    seenRoots.add(root);
    seenIds.add(id);
    return { id, name, root };
}

function validateExtraPath(entries: any[]): string[] {
    const out: string[] = [];
    for (const entry of entries) {
        const s = String(entry ?? '');
        if (s.includes(PATH_DELIM)) {
            throw new HostSettingsError(`PATH entry contains platform delimiter: ${s}`, 'invalid');
        }
        if (/[\0\n\r]/.test(s)) {
            throw new HostSettingsError(`PATH entry contains NUL/newline: ${s}`, 'invalid');
        }
        out.push(s);
    }
    return out;
}

function validateDocument(doc: any): HostSettingsDocument {
    if (!doc || typeof doc !== 'object') {
        throw new HostSettingsError('document must be a JSON object', 'invalid');
    }
    const workspaces: HostWorkspaceEntry[] = [];
    const seenRoots = new Set<string>();
    const seenIds = new Set<string>();
    if (Array.isArray(doc.workspaces)) {
        for (const w of doc.workspaces) workspaces.push(validateWorkspaceEntry(w, seenRoots, seenIds));
    } else if (doc.workspaces !== undefined && doc.workspaces !== null) {
        throw new HostSettingsError('workspaces must be an array', 'invalid');
    }

    let defaultWorkspaceId: string | null = null;
    if (doc.defaultWorkspaceId !== null && doc.defaultWorkspaceId !== undefined) {
        defaultWorkspaceId = String(doc.defaultWorkspaceId).trim();
        if (defaultWorkspaceId && !seenIds.has(defaultWorkspaceId)) {
            throw new HostSettingsError(`defaultWorkspaceId '${defaultWorkspaceId}' not in workspaces`, 'invalid');
        }
        if (defaultWorkspaceId && /[\0\n\r]/.test(defaultWorkspaceId)) {
            throw new HostSettingsError(`defaultWorkspaceId contains NUL/newline`, 'invalid');
        }
    }

    let port: number | null = null;
    if (doc.port !== null && doc.port !== undefined) {
        const p = Number(doc.port);
        if (!Number.isInteger(p) || p < MIN_PORT || p > MAX_PORT) {
            throw new HostSettingsError(`port ${doc.port} out of range (${MIN_PORT}-${MAX_PORT})`, 'invalid');
        }
        port = p;
    }

    let serveMode: ServeMode | null = null;
    if (doc.serveMode !== null && doc.serveMode !== undefined) {
        const m = String(doc.serveMode);
        if (!VALID_SERVE_MODES.has(m as ServeMode)) {
            throw new HostSettingsError(`serveMode '${m}' is not local or tailnet`, 'invalid');
        }
        serveMode = m as ServeMode;
    }

    let extraPath: string[] = [];
    if (Array.isArray(doc.extraPath)) {
        extraPath = validateExtraPath(doc.extraPath);
    } else if (doc.extraPath !== null && doc.extraPath !== undefined) {
        throw new HostSettingsError('extraPath must be an array', 'invalid');
    }

    const out: HostSettingsDocument = {
        version: typeof doc.version === 'number' ? doc.version : SCHEMA_VERSION,
        workspaces,
        defaultWorkspaceId,
        port,
        serveMode,
        extraPath,
    };
    // Preserve unknown stored keys so a newer install is not downgraded by an older writer.
    for (const k of Object.keys(doc)) {
        if (!(k in out)) out[k] = doc[k];
    }
    return out;
}

interface RawRead {
    doc: HostSettingsDocument;
    revision: string;
}

function readRaw(): RawRead | null {
    const fp = settingsFilePath();
    let raw: Buffer;
    try {
        raw = fs.readFileSync(fp);
    } catch (e: any) {
        if (e?.code === 'ENOENT') return null;
        throw new HostSettingsError(`Failed to read host settings: ${e?.message ?? e}`, 'io');
    }
    let parsed: any;
    try {
        parsed = JSON.parse(raw.toString('utf8'));
    } catch (e: any) {
        // A corrupt file fails loudly and remains untouched.
        throw new HostSettingsError(`host-settings.json is corrupt: ${e?.message ?? e}`, 'corrupt');
    }
    return { doc: validateDocument(parsed), revision: computeRevision(raw) };
}

// In-process write serialization: concurrent requests cannot interleave
// validation and replacement. The chain swallows rejections so a failed write
// does not poison the next one.
let _writeChain: Promise<void> = Promise.resolve();

function atomicWrite(data: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const fp = settingsFilePath();
        const dir = path.dirname(fp);
        try {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        } catch (e: any) {
            if (e?.code !== 'EEXIST') {
                reject(new HostSettingsError(`Failed to create settings dir: ${e?.message ?? e}`, 'io'));
                return;
            }
        }
        try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
        const tmp = path.join(dir, `.host-settings.json.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`);
        fs.writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 }, (writeErr) => {
            if (writeErr) {
                reject(new HostSettingsError(`Failed to write temp settings: ${writeErr.message}`, 'io'));
                try { fs.unlink(tmp, () => { /* ignore */ }); } catch { /* ignore */ }
                return;
            }
            fs.rename(tmp, fp, (renameErr) => {
                if (renameErr) {
                    reject(new HostSettingsError(`Failed to replace settings: ${renameErr.message}`, 'io'));
                    try { fs.unlink(tmp, () => { /* ignore */ }); } catch { /* ignore */ }
                    return;
                }
                try { fs.chmodSync(fp, 0o600); } catch { /* best effort */ }
                resolve();
            });
        });
    });
}

const ALLOWED_PATCH_KEYS = new Set([
    'version', 'workspaces', 'defaultWorkspaceId', 'port', 'serveMode', 'extraPath',
]);

function validatePatchSync(patch: Partial<HostSettingsDocument>): void {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new HostSettingsError('patch must be a JSON object', 'invalid');
    }
    for (const k of Object.keys(patch)) {
        if (!ALLOWED_PATCH_KEYS.has(k)) {
            throw new HostSettingsError(`Unknown field '${k}' in patch`, 'invalid');
        }
    }
    if (Array.isArray(patch.workspaces)) {
        const seenRoots = new Set<string>();
        const seenIds = new Set<string>();
        for (const w of patch.workspaces) validateWorkspaceEntry(w, seenRoots, seenIds);
    }
    if (Array.isArray(patch.extraPath)) {
        validateExtraPath(patch.extraPath);
    }
    if (patch.port !== null && patch.port !== undefined) {
        const p = Number(patch.port);
        if (!Number.isInteger(p) || p < MIN_PORT || p > MAX_PORT) {
            throw new HostSettingsError(`port ${patch.port} out of range (${MIN_PORT}-${MAX_PORT})`, 'invalid');
        }
    }
    if (patch.serveMode !== null && patch.serveMode !== undefined) {
        const m = String(patch.serveMode);
        if (!VALID_SERVE_MODES.has(m as ServeMode)) {
            throw new HostSettingsError(`serveMode '${m}' is not local or tailnet`, 'invalid');
        }
    }
    if (patch.defaultWorkspaceId !== null && patch.defaultWorkspaceId !== undefined) {
        const id = String(patch.defaultWorkspaceId).trim();
        if (/[\0\n\r]/.test(id)) {
            throw new HostSettingsError(`defaultWorkspaceId contains NUL/newline`, 'invalid');
        }
    }
}

function synthesizeWorkspace(root: string, prefix: string): HostWorkspaceEntry {
    const resolved = path.resolve(expandAndResolve(root));
    const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 8);
    return {
        id: `${prefix}-${hash}`,
        name: path.basename(resolved) || resolved,
        root: resolved,
    };
}

function buildResolution(
    doc: HostSettingsDocument | null,
    revision: string,
    ctx?: HostSettingsContext,
): HostSettingsResolution {
    const effectiveDoc = doc ?? defaultDocument();
    const explicit = ctx?.explicit;
    const legacy = ctx?.legacy;
    const vscodeCfg = ctx?.vscode;

    const workspacesValue = effectiveDoc.workspaces;
    const workspacesSource: SourceLabel = doc ? 'durable' : 'default';

    // default workspace
    let defaultWsValue: HostWorkspaceEntry | null = null;
    let defaultWsSource: SourceLabel = 'default';
    if (explicit?.workspaceRoot) {
        const root = path.resolve(expandAndResolve(explicit.workspaceRoot.value));
        const match = workspacesValue.find(w => w.root === root);
        defaultWsValue = match ?? synthesizeWorkspace(root, 'cli');
        defaultWsSource = explicit.workspaceRoot.source;
    } else if (effectiveDoc.defaultWorkspaceId) {
        defaultWsValue = workspacesValue.find(w => w.id === effectiveDoc.defaultWorkspaceId) ?? null;
        defaultWsSource = doc ? 'durable' : 'default';
    } else if (legacy?.workspace) {
        const root = path.resolve(expandAndResolve(legacy.workspace));
        const match = workspacesValue.find(w => w.root === root);
        defaultWsValue = match ?? synthesizeWorkspace(root, 'legacy');
        defaultWsSource = 'legacy-env';
    }

    // port
    let portVal: number;
    let portSource: SourceLabel;
    if (explicit?.port) {
        portVal = explicit.port.value;
        portSource = explicit.port.source;
    } else if (effectiveDoc.port != null) {
        portVal = effectiveDoc.port;
        portSource = doc ? 'durable' : 'default';
    } else if (legacy?.port) {
        const p = Number(legacy.port);
        portVal = Number.isInteger(p) && p >= MIN_PORT && p <= MAX_PORT ? p : 7777;
        portSource = 'legacy-env';
    } else {
        portVal = 7777;
        portSource = 'default';
    }

    // serveMode
    let modeVal: ServeMode;
    let modeSource: SourceLabel;
    if (explicit?.serveMode) {
        modeVal = explicit.serveMode.value;
        modeSource = explicit.serveMode.source;
    } else if (vscodeCfg?.tailnetEnabled !== undefined) {
        modeVal = vscodeCfg.tailnetEnabled ? 'tailnet' : 'local';
        modeSource = 'vscode-config';
    } else if (effectiveDoc.serveMode) {
        modeVal = effectiveDoc.serveMode;
        modeSource = doc ? 'durable' : 'default';
    } else if (legacy?.serveMode && VALID_SERVE_MODES.has(legacy.serveMode as ServeMode)) {
        modeVal = legacy.serveMode as ServeMode;
        modeSource = 'legacy-env';
    } else {
        modeVal = 'local';
        modeSource = 'default';
    }

    // extraPath
    let pathVal: string[];
    let pathSource: SourceLabel;
    if (explicit?.extraPath) {
        pathVal = explicit.extraPath.value;
        pathSource = explicit.extraPath.source;
    } else if (effectiveDoc.extraPath.length > 0) {
        pathVal = effectiveDoc.extraPath;
        pathSource = doc ? 'durable' : 'default';
    } else if (legacy?.extraPath) {
        pathVal = legacy.extraPath.split(PATH_DELIM).filter(Boolean);
        pathSource = 'legacy-env';
    } else {
        pathVal = [];
        pathSource = 'default';
    }

    const configuredDefaultWs = effectiveDoc.defaultWorkspaceId
        ? workspacesValue.find(w => w.id === effectiveDoc.defaultWorkspaceId) ?? null
        : null;

    return {
        revision,
        workspaces: {
            value: workspacesValue,
            source: workspacesSource,
            configuredValue: doc ? workspacesValue : null,
            configuredSource: doc ? 'durable' : null,
        },
        defaultWorkspace: {
            effectiveValue: defaultWsValue,
            effectiveSource: defaultWsSource,
            configuredValue: configuredDefaultWs,
            configuredSource: doc ? 'durable' : null,
            available: !!defaultWsValue,
            restartRequired: true,
        },
        port: {
            effectiveValue: portVal,
            effectiveSource: portSource,
            configuredValue: effectiveDoc.port,
            configuredSource: doc ? 'durable' : null,
            available: true,
            restartRequired: true,
        },
        serveMode: {
            effectiveValue: modeVal,
            effectiveSource: modeSource,
            configuredValue: effectiveDoc.serveMode,
            configuredSource: doc ? 'durable' : null,
            available: true,
            restartRequired: true,
        },
        extraPath: {
            effectiveValue: pathVal,
            effectiveSource: pathSource,
            configuredValue: effectiveDoc.extraPath.length ? effectiveDoc.extraPath : null,
            configuredSource: doc ? 'durable' : null,
            available: true,
            restartRequired: true,
        },
    };
}

export function createHostSettingsService(): HostSettingsService {
    const filePath = (): string => settingsFilePath();
    const exists = (): boolean => {
        try { return fs.existsSync(settingsFilePath()); } catch { return false; }
    };

    const read = (): HostSettingsResolution => {
        const raw = readRaw();
        if (!raw) return buildResolution(null, EMPTY_REVISION);
        return buildResolution(raw.doc, raw.revision);
    };

    const resolve = (ctx: HostSettingsContext): HostSettingsResolution => {
        const raw = readRaw();
        if (!raw) return buildResolution(null, EMPTY_REVISION, ctx);
        return buildResolution(raw.doc, raw.revision, ctx);
    };

    const update = async (
        patch: Partial<HostSettingsDocument>,
        expectedRevision: string,
        ctx?: HostSettingsContext,
    ): Promise<HostSettingsResolution> => {
        // Sync validation so invalid input maps to 400 cleanly (the async body
        // would still reject the promise, but validating here keeps the error
        // code deterministic and the IO/conflict path separate).
        validatePatchSync(patch);

        const run = async (): Promise<HostSettingsResolution> => {
            const current = readRaw();
            const currentRevision = current ? current.revision : EMPTY_REVISION;
            if (currentRevision !== expectedRevision) {
                const fresh = buildResolution(current?.doc ?? null, currentRevision, ctx);
                throw new StaleRevisionError(fresh);
            }
            const base = current?.doc ?? defaultDocument();
            const merged: any = { ...base };
            if (patch.workspaces !== undefined) {
                const seenRoots = new Set<string>();
                const seenIds = new Set<string>();
                merged.workspaces = (patch.workspaces ?? []).map(w => validateWorkspaceEntry(w, seenRoots, seenIds));
            }
            if (patch.extraPath !== undefined) {
                merged.extraPath = validateExtraPath(patch.extraPath ?? []);
            }
            if (patch.port !== undefined) {
                merged.port = patch.port == null ? null : Number(patch.port);
            }
            if (patch.serveMode !== undefined) {
                merged.serveMode = patch.serveMode == null ? null : patch.serveMode;
            }
            if (patch.defaultWorkspaceId !== undefined) {
                if (patch.defaultWorkspaceId == null) {
                    merged.defaultWorkspaceId = null;
                } else {
                    const id = String(patch.defaultWorkspaceId).trim();
                    const checkList = patch.workspaces ? merged.workspaces : base.workspaces;
                    if (id && !checkList.some((w: any) => w.id === id)) {
                        throw new HostSettingsError(`defaultWorkspaceId '${id}' not in workspaces`, 'invalid');
                    }
                    merged.defaultWorkspaceId = id;
                }
            }
            if (patch.version !== undefined) {
                merged.version = Number(patch.version) || SCHEMA_VERSION;
            }
            // Preserve unknown keys from base.
            for (const k of Object.keys(base)) {
                if (!(k in merged)) merged[k] = (base as any)[k];
            }
            const validated = validateDocument(merged);
            const data = JSON.stringify(validated, null, 2) + '\n';
            await atomicWrite(data);
            const fresh = readRaw();
            if (!fresh) {
                throw new HostSettingsError('settings file missing after write', 'io');
            }
            return buildResolution(fresh.doc, fresh.revision, ctx);
        };

        // Serialize writes in-process. Rejections are swallowed at the chain
        // level so a failed write does not poison the next one; the caller
        // still sees the rejection from `run`.
        return new Promise<HostSettingsResolution>((resolveFn, rejectFn) => {
            const next = _writeChain.then(() => run(), () => run());
            _writeChain = next.then(() => undefined, () => undefined);
            next.then(resolveFn, rejectFn);
        });
    };

    return { read, resolve, update, filePath, exists };
}

/**
 * Seed the service user's host-settings.json during `switchboard setup host`.
 * Writes the initial document only when no durable file exists, so re-running
 * setup host never silently overwrites an operator's saved settings. Returns
 * the path written and the revision, or null when the file already existed.
 *
 * Unlike `update`, this does NOT require a revision — it is the one writer
 * that bootstraps the file. It is intended to run as the service user (whose
 * HOME owns the file), not as root.
 */
export function seedHostSettingsDocument(initial: {
    workspaces?: HostWorkspaceEntry[];
    defaultWorkspaceId?: string | null;
    port?: number | null;
    serveMode?: ServeMode | null;
    extraPath?: string[];
}): { path: string; revision: string } | null {
    const fp = settingsFilePath();
    if (fs.existsSync(fp)) {
        return null;
    }
    const doc = validateDocument({
        version: SCHEMA_VERSION,
        workspaces: Array.isArray(initial.workspaces) ? initial.workspaces : [],
        defaultWorkspaceId: initial.defaultWorkspaceId ?? null,
        port: initial.port ?? null,
        serveMode: initial.serveMode ?? null,
        extraPath: Array.isArray(initial.extraPath) ? initial.extraPath : [],
    });
    const data = JSON.stringify(doc, null, 2) + '\n';
    // Synchronous atomic write: setup host is a one-shot CLI command, not a
    // concurrent request handler. Same temp+rename discipline.
    const dir = path.dirname(fp);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    const tmp = path.join(dir, `.host-settings.json.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, fp);
    try { fs.chmodSync(fp, 0o600); } catch { /* best effort */ }
    return { path: fp, revision: computeRevision(Buffer.from(data, 'utf8')) };
}

/**
 * Apply a saved PATH array to `process.env.PATH` before child agents can spawn,
 * without shell interpolation. Entries are prepended so agent CLIs in
 * per-user directories win over system paths.
 */
export function applyExtraPathToProcessEnv(entries: string[]): void {
    if (!Array.isArray(entries) || entries.length === 0) return;
    const existing = (process.env.PATH ?? '').split(PATH_DELIM).filter(Boolean);
    const merged: string[] = [];
    for (const e of entries) {
        const s = String(e ?? '').trim();
        if (s && !merged.includes(s)) merged.push(s);
    }
    for (const e of existing) {
        if (!merged.includes(e)) merged.push(e);
    }
    process.env.PATH = merged.join(PATH_DELIM);
}
