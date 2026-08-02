'use strict';

/**
 * Verb Engine test-seam harness — Verb Engine · 1 (A2b foundations).
 *
 * Shared by the per-provider burndown tests (subtasks 2–6). Provides:
 *
 *  - `installVscodeTrap()` — a booby-trapped `vscode` module: ANY property
 *    access throws. Loading a provider module is safe (imports don't touch
 *    properties); a migrated arm that still reaches vscode fails loudly with
 *    the exact property named. This — not "it compiles" — is the acceptance
 *    signal for arm migration.
 *
 *  - `createHeadlessTestSeams(opts)` — an in-memory HostSeams bundle plus the
 *    recorders tests assert against (clipboard writes, notifications, secrets,
 *    picked folders, watched folders, executed commands).
 *
 * Usage (see verb-engine-headless-seams.test.js):
 *   const { installVscodeTrap, createHeadlessTestSeams } = require('./helpers/verbEngineTestSeams');
 *   installVscodeTrap();                          // BEFORE requiring out/services/*
 *   const provider = Object-construct or `new` with fake ctor args;
 *   provider._hostSeams = createHeadlessTestSeams({ roots: [tmpRoot] }).seams;
 *   provider._broadcaster = new BroadcastHub({ webview: fakeWebview, apiServer: null });
 */

const Module = require('module');

let _trapInstalled = false;

function installVscodeTrap() {
    if (_trapInstalled) return;
    _trapInstalled = true;
    const originalLoad = Module._load;
    const trap = new Proxy({}, {
        get(_target, prop) {
            // Interop probes that must not throw:
            // - `__esModule: true` makes tsc's __importStar return the trap as-is
            //   (so later property access hits this proxy, not a copied husk).
            // - `then`/symbols are probed by `await import()` and util.inspect.
            if (prop === '__esModule') return true;
            if (prop === 'then' || typeof prop === 'symbol') return undefined;
            if (prop === 'default') return trap;
            throw new Error(
                `[verb-engine trap] vscode.${String(prop)} was reached during headless execution — ` +
                'this code path is not host-agnostic. Route it through a HostSeams member.'
            );
        },
    });
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return trap;
        return originalLoad.apply(this, arguments);
    };
}

/**
 * A PERMISSIVE, RECORDING `vscode` module stub — the counterpart to
 * `installVscodeTrap()` for providers whose CONSTRUCTOR is not yet host-agnostic.
 *
 * `TaskViewerProvider`'s instance-field initializers call
 * `vscode.window.createOutputChannel(...)` (TaskViewerProvider.ts, `_julesDiagnosticsChannel`
 * / `_apiServerDiagnosticsChannel`), so the booby trap fires in `new` before any
 * arm can run. That is a documented unmigrated-ctor problem with its own plan
 * (see the NOT WIRED YET comment in .github/workflows/integration-tests.yml) —
 * NOT a harness bug, and not something an arm-level contract test can fix.
 *
 * This stub lets the ctor complete while still preserving the A2b acceptance
 * signal where it actually matters: every property path touched is recorded, so
 * a test can snapshot `accesses.length` around a `handleServiceVerb` call and
 * assert the ARM reached no vscode at all. Prefer `installVscodeTrap()` whenever
 * the provider under test can be constructed under it.
 *
 * `values` is a MUTABLE map from dotted path to a literal value, consulted
 * before a proxy node is manufactured. It exists because some provider paths read
 * `vscode` directly rather than through a seam — notably
 * `_getWorkspaceRoots()` → `vscode.workspace.workspaceFolders`, which every root
 * validation (`_getAllowedRoots` / `_resolveWorkspaceRoot`) depends on. Set it
 * with `setWorkspaceFolders([root])` before exercising an arm that validates a
 * workspace root, or the arm will resolve no roots.
 *
 * Returns `{ accesses, values, setWorkspaceFolders(roots), reset() }`.
 * Idempotent; safe to call once per process.
 */
let _stubInstalled = null;

function installPermissiveVscodeStub() {
    if (_stubInstalled) return _stubInstalled;
    const accesses = [];
    const values = Object.create(null);
    const makeNode = (pathStr) => new Proxy(function () { }, {
        get(_t, prop) {
            if (prop === '__esModule') return true;
            // Give coercion a primitive so an accidental String(node) yields the
            // path instead of "Cannot convert object to primitive value".
            if (prop === Symbol.toPrimitive) return () => `[vscode:${pathStr}]`;
            if (prop === 'then' || typeof prop === 'symbol') return undefined;
            const next = pathStr ? `${pathStr}.${String(prop)}` : String(prop);
            accesses.push(next);
            if (next in values) return values[next];
            return makeNode(next);
        },
        apply() { return makeNode(`${pathStr}()`); },
        construct() { return makeNode(`new ${pathStr}`); },
    });
    // Defaults for the two paths whose PROXY return value would otherwise be
    // coerced into a bogus string: `getConfiguration().get()` feeds a DB path,
    // and `workspaceFolders` must be an array (or absent), never a callable node.
    values['workspace.getConfiguration'] = () => ({
        get: () => undefined,
        has: () => false,
        inspect: () => undefined,
        update: async () => { },
    });
    values['workspace.workspaceFolders'] = undefined;

    const root = makeNode('');
    const originalLoad = Module._load;
    Module._load = function (request) {
        if (request === 'vscode') return root;
        return originalLoad.apply(this, arguments);
    };
    _stubInstalled = {
        accesses,
        values,
        setWorkspaceFolders: (roots) => {
            values['workspace.workspaceFolders'] = (roots || []).map(r => ({ uri: { fsPath: r } }));
        },
        reset: () => { accesses.length = 0; },
    };
    return _stubInstalled;
}

/**
 * In-memory HostSeams bundle. `opts.roots` — workspace roots the HostWorkspace
 * seam reports. `opts.pickFolderResult` / `opts.pickFilesResult` — what the
 * dialog seams resolve to (default undefined = user cancelled).
 */
function createHeadlessTestSeams(opts = {}) {
    const recorders = {
        clipboardWrites: [],
        notifications: [],
        errorMessages: [],
        warningMessages: [],
        infoMessages: [],
        secrets: new Map(Object.entries(opts.secrets || {})),
        configWrites: [],
        executedCommands: [],
        watchedFolders: [],
        disposedWatchers: [],
        openedDocuments: [],
        terminalSends: [],
        openedExternals: [],
        pickedItems: [],
    };

    const seams = {
        // Non-empty by default so the `-${appName}` suffix tier of terminal-name
        // resolution is actually exercised; pass `appName: ''` to assert the
        // standalone shape, where a blank name means "apply no suffix at all".
        appName: opts.appName !== undefined ? opts.appName : 'TestHost',
        // Single pathConfig seam. Precedence: `opts.config[key]` (untyped bag)
        // → the typed bag (`configStrings`/`configBooleans`/`configNumbers`/
        // `configJson`) → the caller's default. This object literal previously
        // declared `pathConfig` TWICE; last-wins silently killed the
        // `opts.config`-backed getters and `workspaceRoot`. Do not re-split.
        pathConfig: {
            workspaceRoot: (opts.roots && opts.roots[0]) || '',
            getConfigString: (key, def = '') =>
                opts.config && key in opts.config
                    ? opts.config[key]
                    : opts.configStrings?.[key] ?? def,
            getConfigStringWithDefault: (key, def = '') =>
                opts.config && key in opts.config
                    ? opts.config[key]
                    : opts.configStrings?.[key] ?? def,
            getConfigBoolean: (key, def = false) =>
                opts.config && key in opts.config
                    ? !!opts.config[key]
                    : opts.configBooleans?.[key] ?? def,
            getConfigNumber: (key, def = 0) =>
                opts.config && key in opts.config
                    ? Number(opts.config[key])
                    : opts.configNumbers?.[key] ?? def,
            getConfigJson: (key, def = undefined) =>
                opts.config && key in opts.config
                    ? opts.config[key]
                    : opts.configJson?.[key] ?? def,
            updateConfig: async (key, value) => {
                recorders.configWrites.push({ scope: 'workspace', key, value });
            },
            updateConfigGlobal: async (key, value) => {
                recorders.configWrites.push({ scope: 'global', key, value });
            },
            updateConfigWorkspace: async (key, value) => {
                recorders.configWrites.push({ scope: 'workspace', key, value });
            },
        },
        // `findByName` used to be a hard `() => null`, which made every arm that
        // must RESOLVE a terminal before writing (sendToTerminal) unreachable —
        // the arm correctly returned "not found or not local" and the test read
        // that as an arm defect. Seed resolvable terminals with `opts.terminals`;
        // the default stays empty, so callers that want the not-found path keep it.
        terminal: (() => {
            const makeHandle = (name) => ({
                name,
                sendText: (text) => recorders.terminalSends.push({ name, text }),
                dispose: () => {},
                show: () => {},
            });
            // `create` adds to the same map so a create-then-send flow resolves.
            // No `processId` on these handles — that is what routes the arm down
            // the host-agnostic `sendText` path instead of VS Code's sendRobustText.
            const existing = new Map((opts.terminals || []).map(n => [n, makeHandle(n)]));
            return {
                create: (name) => {
                    const handle = makeHandle(name);
                    existing.set(name, handle);
                    return handle;
                },
                findByName: (name) => existing.get(name) || null,
                findByNameContains: (fragment) => {
                    for (const [n, h] of existing) {
                        if (fragment && n.includes(fragment)) return h;
                    }
                    return null;
                },
                sendInput: (name, text) => {
                    recorders.terminalSends.push({ name, text });
                    return true;
                },
                kill: () => false,
                resize: () => false,
                onClose: () => {},
            };
        })(),
        commands: {
            executeCommand: async (command, ...args) => {
                recorders.executedCommands.push({ command, args });
                if (opts.commandResults && command in opts.commandResults) {
                    const r = opts.commandResults[command];
                    return typeof r === 'function' ? await r(...args) : r;
                }
                return undefined;
            },
        },
        ui: {
            showWarningMessage: async (message) => {
                recorders.warningMessages.push(message);
                return opts.warningMessageResult;
            },
            showInformationMessage: async (message) => {
                recorders.infoMessages.push(message);
                return undefined;
            },
            showErrorMessage: async (message) => {
                recorders.errorMessages.push(message);
                return undefined;
            },
            showModalWarningMessage: async (message) => {
                recorders.warningMessages.push(message);
                return opts.modalWarningResult;
            },
            showTemporaryNotification: (message) => {
                recorders.notifications.push(message);
            },
            showInputBox: async (options) => {
                recorders.pickedItems.push({ kind: 'inputBox', options });
                return opts.inputBoxResult;
            },
            showQuickPick: async (items, options) => {
                recorders.pickedItems.push({ kind: 'quickPick', items, options });
                if (opts.quickPickResult !== undefined) return opts.quickPickResult;
                if (options && options.canPickMany) return [];
                return undefined;
            },
            showOpenDialog: async (options) => {
                recorders.pickedItems.push({ kind: 'openDialog', options });
                return opts.showOpenDialogResult;
            },
            openExternal: async (url) => {
                recorders.openedExternals.push(url);
            },
            pickFolder: async () => opts.pickFolderResult,
            pickFiles: async () => opts.pickFilesResult,
        },
        editor: {
            openTextDocument: async (filePath) => {
                recorders.openedDocuments.push(filePath);
            },
            showTextDocument: async (filePath) => {
                recorders.openedDocuments.push(filePath);
            },
        },
        secrets: {
            get: async (key) => recorders.secrets.get(key),
            store: async (key, value) => {
                recorders.secrets.set(key, value);
            },
            delete: async (key) => {
                recorders.secrets.delete(key);
            },
        },
        clipboard: {
            writeText: async (text) => {
                recorders.clipboardWrites.push(text);
            },
            readText: async () => recorders.clipboardWrites[recorders.clipboardWrites.length - 1] || '',
        },
        workspace: {
            getWorkspaceRoots: () => opts.roots || [],
        },
        watcher: {
            watchFolder: (folderPath, _listener) => {
                recorders.watchedFolders.push(folderPath);
                return {
                    dispose: () => recorders.disposedWatchers.push(folderPath),
                };
            },
            watchFile: (filePath, _listener) => {
                recorders.watchedFiles = recorders.watchedFiles || [];
                recorders.watchedFiles.push(filePath);
                return {
                    dispose: () => {},
                };
            },
        },
    };

    return { seams, recorders };
}

/** Minimal in-memory PanelStateStore-compatible fake. */
function createFakeStateStore() {
    const panelStates = new Map();
    const rootStates = new Map(); // key: `${tabKey}|${root}`
    return {
        panelStates,
        rootStates,
        getRootState: (tabKey, root) => rootStates.get(`${tabKey}|${root}`),
        setRootState: async (tabKey, root, value) => {
            rootStates.set(`${tabKey}|${root}`, value);
        },
        getPanelState: (tabKey) => panelStates.get(tabKey),
        setPanelState: async (tabKey, value) => {
            panelStates.set(tabKey, value);
        },
        getAllStates: (tabKeys, roots) => {
            const panel = {};
            const byRoot = {};
            for (const tabKey of tabKeys) {
                if (panelStates.has(tabKey)) panel[tabKey] = panelStates.get(tabKey);
                byRoot[tabKey] = {};
                for (const root of roots) {
                    const v = rootStates.get(`${tabKey}|${root}`);
                    if (v !== undefined) byRoot[tabKey][root] = v;
                }
            }
            return { panel, byRoot };
        },
    };
}

module.exports = {
    installVscodeTrap,
    installPermissiveVscodeStub,
    createHeadlessTestSeams,
    createFakeStateStore,
};
