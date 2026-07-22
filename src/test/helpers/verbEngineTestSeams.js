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
        pathConfig: {
            workspaceRoot: (opts.roots && opts.roots[0]) || '',
            getConfigString: (key) => (opts.config && opts.config[key]) || '',
            getConfigStringWithDefault: (key, dflt) =>
                opts.config && key in opts.config ? opts.config[key] : dflt,
            getConfigBoolean: (key, dflt) =>
                opts.config && key in opts.config ? !!opts.config[key] : dflt,
            getConfigNumber: (key, dflt) =>
                opts.config && key in opts.config ? Number(opts.config[key]) : dflt,
            getConfigJson: (key, dflt) =>
                opts.config && key in opts.config ? opts.config[key] : dflt,
            updateConfigGlobal: async (key, value) => {
                recorders.configWrites.push({ scope: 'global', key, value });
            },
            updateConfigWorkspace: async (key, value) => {
                recorders.configWrites.push({ scope: 'workspace', key, value });
            },
        },
        terminal: {
            create: (name) => {
                const handle = {
                    name,
                    sendText: (text) => recorders.terminalSends.push({ name, text }),
                    dispose: () => {},
                    show: () => {},
                };
                return handle;
            },
            findByName: () => null,
            findByNameContains: () => null,
            sendInput: (name, text) => {
                recorders.terminalSends.push({ name, text });
                return true;
            },
            kill: () => false,
            resize: () => false,
            onClose: () => {},
        },
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
        pathConfig: {
            getConfigString: (key, def = '') => opts.configStrings?.[key] ?? def,
            getConfigStringWithDefault: (key, def = '') => opts.configStrings?.[key] ?? def,
            getConfigBoolean: (key, def = false) => opts.configBooleans?.[key] ?? def,
            getConfigNumber: (key, def = 0) => opts.configNumbers?.[key] ?? def,
            getConfigJson: (key, def = undefined) => opts.configJson?.[key] ?? def,
            updateConfig: async () => {},
            updateConfigGlobal: async () => {},
            updateConfigWorkspace: async () => {},
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

module.exports = { installVscodeTrap, createHeadlessTestSeams, createFakeStateStore };
